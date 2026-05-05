#!/usr/bin/env node

import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

const DASHBOARD_ROOT = process.cwd();
const UDS_ROOT = path.resolve(DASHBOARD_ROOT, '..', 'unified_design_system');
const BLUEPRINT_ROOT = path.resolve(DASHBOARD_ROOT, '..', 'blueprint-storybook-poc');

const UDS_COMPONENT_ROOT = path.join(UDS_ROOT, 'packages', 'components', 'src');
const BLUEPRINT_COMPONENT_ROOT = path.join(BLUEPRINT_ROOT, 'design-system-tokens', '3-components');
const BLUEPRINT_STORY_ROOT = path.join(BLUEPRINT_ROOT, 'stories');

const FIGMA_MAPPING_PATH = path.join(DASHBOARD_ROOT, 'data', 'figma-mapping.json');
const REPORT_PATH = path.join(DASHBOARD_ROOT, 'data', 'component-comparison-report.json');
const OVERRIDES_PATH = path.join(DASHBOARD_ROOT, 'data', 'component-completion-overrides.json');

const TARGET_HTML_FILES = [
  path.join(DASHBOARD_ROOT, 'index.html'),
  path.join(DASHBOARD_ROOT, 'dashboard', 'blueprint-status.html')
];

const UDS_LAYERS = [
  { dir: 'atoms', type: 'Atom', blueprintDir: 'atoms', storyDir: 'atoms' },
  { dir: 'molecules', type: 'Molecule', blueprintDir: 'molecules', storyDir: 'molecules' },
  { dir: 'organisms', type: 'Organism', blueprintDir: 'organisms', storyDir: 'organisms' }
];

function toKebabCase(value) {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[\s_]+/g, '-')
    .toLowerCase();
}

function normalizeKey(value) {
  return value.replace(/[^a-z0-9]/gi, '').toLowerCase();
}

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function objectLiteralString(obj, indentLevel = 2) {
  const space = ' '.repeat(indentLevel);
  const lines = Object.entries(obj).map(([key, value]) => `${space}"${key}": ${value}`);
  return `{\n${lines.join(',\n')}\n}`;
}

async function exists(targetPath) {
  try {
    await stat(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function listDirectories(dirPath) {
  const entries = await readdir(dirPath, { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
}

async function listFiles(dirPath) {
  const entries = await readdir(dirPath, { withFileTypes: true });
  return entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
}

async function getImplementedUdsComponents() {
  const components = [];

  for (const layer of UDS_LAYERS) {
    const layerPath = path.join(UDS_COMPONENT_ROOT, layer.dir);
    const componentDirs = await listDirectories(layerPath);

    for (const componentName of componentDirs) {
      const componentFilePath = path.join(layerPath, componentName, `${componentName}.tsx`);
      if (await exists(componentFilePath)) {
        components.push({
          id: `${layer.type}:${componentName}`,
          name: componentName,
          type: layer.type,
          layerDir: layer.dir,
          blueprintDir: layer.blueprintDir,
          storyDir: layer.storyDir,
          udsPath: componentFilePath
        });
      }
    }
  }

  return components.sort((a, b) => a.id.localeCompare(b.id));
}

async function buildBlueprintIndices() {
  const implementationIndex = {};
  const storyIndex = {};

  for (const layer of UDS_LAYERS) {
    const componentLayerPath = path.join(BLUEPRINT_COMPONENT_ROOT, layer.blueprintDir);
    const storyLayerPath = path.join(BLUEPRINT_STORY_ROOT, layer.storyDir);

    const dirNames = await listDirectories(componentLayerPath);
    implementationIndex[layer.blueprintDir] = {};

    for (const dirName of dirNames) {
      const normalized = normalizeKey(dirName);
      if (!implementationIndex[layer.blueprintDir][normalized]) {
        implementationIndex[layer.blueprintDir][normalized] = [];
      }
      implementationIndex[layer.blueprintDir][normalized].push(dirName);
    }

    const storyFiles = await listFiles(storyLayerPath);
    storyIndex[layer.storyDir] = new Set(
      storyFiles
        .filter((file) => file.endsWith('.stories.tsx'))
        .map((file) => normalizeKey(file.replace(/\.stories\.tsx$/, '')))
    );
  }

  return { implementationIndex, storyIndex };
}

async function hasBlueprintImplementation(component, implementationIndex) {
  const normalized = normalizeKey(toKebabCase(component.name));
  const layerCandidates = implementationIndex[component.blueprintDir]?.[normalized] || [];
  if (layerCandidates.length === 0) {
    return false;
  }

  for (const candidate of layerCandidates) {
    const candidatePath = path.join(BLUEPRINT_COMPONENT_ROOT, component.blueprintDir, candidate);
    const files = await listFiles(candidatePath);
    if (files.some((file) => file.toLowerCase().endsWith('.tsx'))) {
      return true;
    }
  }

  return false;
}

function hasBlueprintStory(component, storyIndex) {
  const normalized = normalizeKey(toKebabCase(component.name));
  if (storyIndex[component.storyDir]?.has(normalized)) {
    return true;
  }

  return Object.values(storyIndex).some((set) => set.has(normalized));
}

async function getUdsStoryPath(component) {
  const storiesDir = path.join(UDS_COMPONENT_ROOT, component.layerDir, component.name, '_stories');
  if (!(await exists(storiesDir))) {
    return null;
  }

  const storyFiles = (await listFiles(storiesDir)).filter((file) => file.endsWith('.stories.tsx'));
  if (storyFiles.length === 0) {
    return null;
  }

  return path.join(storiesDir, storyFiles[0]);
}

async function getFigmaLinkFromUdsStory(component) {
  const storyPath = await getUdsStoryPath(component);
  if (!storyPath) {
    return null;
  }

  const content = await readFile(storyPath, 'utf8');
  const match = content.match(/https:\/\/www\.figma\.com\/design\/[^'"`)\s]+/);
  return match ? match[0] : null;
}

function isCanonicalFigmaUrl(url) {
  return typeof url === 'string' && url.includes('D4wgJpVFwWQp6AHElpoJK9/Storybook-Branch');
}

async function readFigmaMapping() {
  if (!(await exists(FIGMA_MAPPING_PATH))) {
    return {};
  }

  const content = await readFile(FIGMA_MAPPING_PATH, 'utf8');
  const parsed = JSON.parse(content);
  return parsed?.mappings || {};
}

function computeBlueprintScore(hasImplementation, hasStory) {
  if (hasImplementation && hasStory) {
    return 100;
  }
  if (hasImplementation && !hasStory) {
    return 85;
  }
  if (!hasImplementation && hasStory) {
    return 70;
  }
  return 0;
}

function computeFigmaScore(figmaLink, canonical) {
  if (!figmaLink) {
    return 40;
  }
  return canonical ? 100 : 85;
}

function computeDonePercent(blueprintComparable, blueprintScore, figmaScore) {
  if (!blueprintComparable) {
    return null;
  }
  // Looser curve: higher baseline and gentler penalties.
  const raw = 35 + blueprintScore * 0.35 + figmaScore * 0.3;
  return round(Math.max(0, Math.min(100, raw)));
}

async function buildComparisonReport() {
  const [components, figmaMapping, { implementationIndex, storyIndex }] = await Promise.all([
    getImplementedUdsComponents(),
    readFigmaMapping(),
    buildBlueprintIndices()
  ]);

  const entries = [];

  for (const component of components) {
    const blueprintImplementation = await hasBlueprintImplementation(component, implementationIndex);
    const blueprintStory = hasBlueprintStory(component, storyIndex);
    const blueprintComparable = blueprintImplementation || blueprintStory;

    const udsFigmaLink = await getFigmaLinkFromUdsStory(component);
    const mappedFigmaLink = figmaMapping[component.name]?.figma || null;
    const figmaLink = udsFigmaLink || mappedFigmaLink;
    const figmaCanonical = isCanonicalFigmaUrl(figmaLink);

    const blueprintScore = computeBlueprintScore(blueprintImplementation, blueprintStory);
    const figmaScore = computeFigmaScore(figmaLink, figmaCanonical);
    const donePercent = computeDonePercent(blueprintComparable, blueprintScore, figmaScore);
    const comparisonNote = blueprintComparable
      ? null
      : 'No matching Blueprint component found; excluded from percent calculation.';

    entries.push({
      id: component.id,
      name: component.name,
      type: component.type,
      udsImplemented: true,
      blueprintImplementation,
      blueprintStory,
      blueprintComparable,
      figmaLink: figmaLink || null,
      figmaCanonical,
      blueprintScore,
      figmaScore,
      donePercent,
      comparisonNote
    });
  }

  const comparableEntries = entries.filter((entry) => entry.blueprintComparable && typeof entry.donePercent === 'number');

  const summary = {
    totalImplemented: entries.length,
    blueprintImplementationCoverage: entries.filter((entry) => entry.blueprintImplementation).length,
    blueprintStoryCoverage: entries.filter((entry) => entry.blueprintStory).length,
    figmaLinkCoverage: entries.filter((entry) => !!entry.figmaLink).length,
    figmaCanonicalCoverage: entries.filter((entry) => entry.figmaCanonical).length,
    comparableCount: comparableEntries.length,
    excludedNoBlueprintCount: entries.length - comparableEntries.length,
    averageDonePercent: comparableEntries.length > 0
      ? round(comparableEntries.reduce((sum, entry) => sum + entry.donePercent, 0) / comparableEntries.length)
      : null
  };

  return {
    generatedAt: new Date().toISOString(),
    sourceRepos: {
      uds: UDS_ROOT,
      blueprint: BLUEPRINT_ROOT
    },
    summary,
    entries: entries.sort((a, b) => a.id.localeCompare(b.id))
  };
}

async function writeOutputs(report) {
  await writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  const overrides = {};
  report.entries.forEach((entry) => {
    overrides[entry.id] = entry.donePercent;
  });
  await writeFile(OVERRIDES_PATH, `${JSON.stringify(overrides, null, 2)}\n`, 'utf8');

  return overrides;
}

async function syncHtmlOverrides(overrides) {
  const replacement = `var componentCompletionOverrides = ${objectLiteralString(overrides, 2)};`;
  const pattern = /var componentCompletionOverrides = \{[\s\S]*?\};/;

  for (const filePath of TARGET_HTML_FILES) {
    const content = await readFile(filePath, 'utf8');
    if (!pattern.test(content)) {
      throw new Error(`Could not find componentCompletionOverrides block in ${filePath}`);
    }
    const updated = content.replace(pattern, replacement);
    await writeFile(filePath, updated, 'utf8');
  }
}

async function main() {
  const report = await buildComparisonReport();
  const overrides = await writeOutputs(report);
  await syncHtmlOverrides(overrides);

  console.log('Component comparison sync complete.');
  console.log(`Implemented components compared: ${report.summary.totalImplemented}`);
  console.log(`Blueprint implementation coverage: ${report.summary.blueprintImplementationCoverage}`);
  console.log(`Blueprint story coverage: ${report.summary.blueprintStoryCoverage}`);
  console.log(`Figma link coverage: ${report.summary.figmaLinkCoverage}`);
  console.log(`Canonical Figma coverage: ${report.summary.figmaCanonicalCoverage}`);
  console.log(`Components considered in percent: ${report.summary.comparableCount}`);
  console.log(`Excluded (no Blueprint component): ${report.summary.excludedNoBlueprintCount}`);
  console.log(`Average done percent (considered only): ${report.summary.averageDonePercent}%`);
  console.log(`Wrote: ${path.relative(DASHBOARD_ROOT, REPORT_PATH)}`);
  console.log(`Wrote: ${path.relative(DASHBOARD_ROOT, OVERRIDES_PATH)}`);
  console.log('Synced overrides in index.html and dashboard/blueprint-status.html');
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
