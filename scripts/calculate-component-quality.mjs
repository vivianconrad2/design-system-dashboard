#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';

const DEFAULT_INPUT = 'data/component-quality.sample.json';
const DEFAULT_OUTPUT = 'data/component-quality-report.json';

const TOP_LEVEL_KEYS = ['blueprint', 'figma', 'engineering'];
const DIMENSION_KEYS = {
  blueprint: ['apiParity', 'variantStateParity', 'behaviorParity'],
  figma: ['tokenParity', 'visualStateParity', 'layoutParity'],
  engineering: ['tests', 'storybook', 'ci']
};

function parseArgs(argv) {
  const args = {
    input: DEFAULT_INPUT,
    output: DEFAULT_OUTPUT,
    stdout: false
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--input' && argv[i + 1]) {
      args.input = argv[i + 1];
      i += 1;
    } else if (arg === '--output' && argv[i + 1]) {
      args.output = argv[i + 1];
      i += 1;
    } else if (arg === '--stdout') {
      args.stdout = true;
    }
  }

  return args;
}

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function toNumber(value) {
  if (typeof value === 'number') {
    return value;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : NaN;
}

function assertRange(label, value, min, max, errors) {
  const num = toNumber(value);
  if (!Number.isFinite(num) || num < min || num > max) {
    errors.push(`${label} must be a number between ${min} and ${max}.`);
    return NaN;
  }
  return num;
}

function validateWeightsObject(label, weights, keys, errors) {
  if (!weights || typeof weights !== 'object') {
    errors.push(`${label} is required and must be an object.`);
    return;
  }

  keys.forEach((key) => {
    assertRange(`${label}.${key}`, weights[key], 0, 1, errors);
  });
}

function validateSignalsObject(label, signals, keys, errors) {
  if (!signals || typeof signals !== 'object') {
    errors.push(`${label} is required and must be an object.`);
    return;
  }

  keys.forEach((key) => {
    assertRange(`${label}.${key}`, signals[key], 0, 100, errors);
  });
}

function validatePayload(payload) {
  const errors = [];

  if (!payload || typeof payload !== 'object') {
    throw new Error('Input payload must be a JSON object.');
  }

  if (typeof payload.version !== 'string' || payload.version.trim() === '') {
    errors.push('version is required and must be a non-empty string.');
  }

  validateWeightsObject('weights', payload.weights, TOP_LEVEL_KEYS, errors);

  if (!payload.dimensionWeights || typeof payload.dimensionWeights !== 'object') {
    errors.push('dimensionWeights is required and must be an object.');
  } else {
    TOP_LEVEL_KEYS.forEach((dimension) => {
      validateWeightsObject(
        `dimensionWeights.${dimension}`,
        payload.dimensionWeights[dimension],
        DIMENSION_KEYS[dimension],
        errors
      );
    });
  }

  if (!payload.thresholds || typeof payload.thresholds !== 'object') {
    errors.push('thresholds is required and must be an object.');
  } else {
    assertRange('thresholds.perfect', payload.thresholds.perfect, 0, 100, errors);
    assertRange('thresholds.done', payload.thresholds.done, 0, 100, errors);
    assertRange('thresholds.mostlyDone', payload.thresholds.mostlyDone, 0, 100, errors);
  }

  if (!Array.isArray(payload.components)) {
    errors.push('components is required and must be an array.');
  } else {
    payload.components.forEach((component, index) => {
      const prefix = `components[${index}]`;
      if (!component || typeof component !== 'object') {
        errors.push(`${prefix} must be an object.`);
        return;
      }

      if (typeof component.id !== 'string' || component.id.trim() === '') {
        errors.push(`${prefix}.id is required and must be a non-empty string.`);
      }
      if (typeof component.name !== 'string' || component.name.trim() === '') {
        errors.push(`${prefix}.name is required and must be a non-empty string.`);
      }
      if (!['Atom', 'Molecule', 'Organism', 'Template'].includes(component.type)) {
        errors.push(`${prefix}.type must be one of Atom, Molecule, Organism, Template.`);
      }
      if (typeof component.implemented !== 'boolean') {
        errors.push(`${prefix}.implemented must be a boolean.`);
      }

      if (component.implemented) {
        if (!component.signals || typeof component.signals !== 'object') {
          errors.push(`${prefix}.signals is required for implemented components.`);
        } else {
          TOP_LEVEL_KEYS.forEach((dimension) => {
            validateSignalsObject(
              `${prefix}.signals.${dimension}`,
              component.signals[dimension],
              DIMENSION_KEYS[dimension],
              errors
            );
          });
        }
      }
    });
  }

  if (errors.length > 0) {
    throw new Error(`Invalid component quality payload:\n- ${errors.join('\n- ')}`);
  }
}

function weightedAverage(signalMap, weightMap, keys) {
  let totalWeight = 0;
  let weightedScore = 0;

  keys.forEach((key) => {
    const weight = clamp(toNumber(weightMap[key]), 0, 1);
    const score = clamp(toNumber(signalMap[key]), 0, 100);
    totalWeight += weight;
    weightedScore += score * weight;
  });

  if (totalWeight === 0) {
    return 0;
  }

  return weightedScore / totalWeight;
}

function getBand(score, thresholds) {
  if (score >= thresholds.perfect) {
    return 'perfect';
  }
  if (score >= thresholds.done) {
    return 'done';
  }
  if (score >= thresholds.mostlyDone) {
    return 'mostly_done';
  }
  return 'needs_work';
}

function scoreImplementedComponent(component, payload) {
  const blueprintScore = weightedAverage(
    component.signals.blueprint,
    payload.dimensionWeights.blueprint,
    DIMENSION_KEYS.blueprint
  );
  const figmaScore = weightedAverage(
    component.signals.figma,
    payload.dimensionWeights.figma,
    DIMENSION_KEYS.figma
  );
  const engineeringScore = weightedAverage(
    component.signals.engineering,
    payload.dimensionWeights.engineering,
    DIMENSION_KEYS.engineering
  );

  const finalScore = weightedAverage(
    {
      blueprint: blueprintScore,
      figma: figmaScore,
      engineering: engineeringScore
    },
    payload.weights,
    TOP_LEVEL_KEYS
  );

  return {
    id: component.id,
    name: component.name,
    type: component.type,
    score: round(finalScore, 2),
    band: getBand(finalScore, payload.thresholds),
    breakdown: {
      blueprint: round(blueprintScore, 2),
      figma: round(figmaScore, 2),
      engineering: round(engineeringScore, 2)
    },
    sources: component.sources || {},
    notes: component.notes || ''
  };
}

function summarize(scoredComponents, thresholds) {
  const implementedCount = scoredComponents.length;
  const perfectCount = scoredComponents.filter((component) => component.score >= thresholds.perfect).length;
  const scoreTotal = scoredComponents.reduce((sum, component) => sum + component.score, 0);
  const averageScore = implementedCount > 0 ? scoreTotal / implementedCount : 0;

  const byBand = {
    perfect: 0,
    done: 0,
    mostly_done: 0,
    needs_work: 0
  };
  scoredComponents.forEach((component) => {
    byBand[component.band] += 1;
  });

  const byTypeMap = new Map();
  scoredComponents.forEach((component) => {
    const current = byTypeMap.get(component.type) || [];
    current.push(component);
    byTypeMap.set(component.type, current);
  });

  const byType = Array.from(byTypeMap.entries())
    .map(([type, items]) => {
      const avg = items.reduce((sum, item) => sum + item.score, 0) / items.length;
      const perfect = items.filter((item) => item.score >= thresholds.perfect).length;
      return {
        type,
        implementedCount: items.length,
        averageScore: round(avg, 2),
        perfectCount: perfect,
        percentPerfect: round((perfect / items.length) * 100, 2)
      };
    })
    .sort((a, b) => b.averageScore - a.averageScore);

  return {
    implementedComponentCount: implementedCount,
    portfolioPercentDone: round(averageScore, 2),
    percentPerfect: implementedCount > 0 ? round((perfectCount / implementedCount) * 100, 2) : 0,
    countsByBand: byBand,
    byType
  };
}

function printConsoleReport(report) {
  console.log('');
  console.log('Component Quality Score Report');
  console.log('==============================');
  console.log(`Input file: ${report.meta.inputFile}`);
  console.log(`Implemented components scored: ${report.summary.implementedComponentCount}`);
  console.log(`Portfolio % done: ${report.summary.portfolioPercentDone}%`);
  console.log(`% perfect (>= ${report.config.thresholds.perfect}%): ${report.summary.percentPerfect}%`);
  console.log('');
  console.log('Band counts:');
  console.log(
    `  perfect=${report.summary.countsByBand.perfect}, done=${report.summary.countsByBand.done}, mostly_done=${report.summary.countsByBand.mostly_done}, needs_work=${report.summary.countsByBand.needs_work}`
  );
  console.log('');
  console.log('Type rollups:');
  report.summary.byType.forEach((row) => {
    console.log(
      `  ${row.type}: avg=${row.averageScore}% (implemented=${row.implementedCount}, perfect=${row.perfectCount}, perfect%=${row.percentPerfect}%)`
    );
  });
  console.log('');
  console.log('Lowest scoring implemented components:');
  report.components
    .slice()
    .sort((a, b) => a.score - b.score)
    .slice(0, Math.min(5, report.components.length))
    .forEach((component) => {
      console.log(
        `  ${component.id} -> ${component.score}% [${component.band}] (Blueprint ${component.breakdown.blueprint} / Figma ${component.breakdown.figma} / Engineering ${component.breakdown.engineering})`
      );
    });
  console.log('');
}

async function readJson(filePath) {
  const content = await readFile(filePath, 'utf8');
  return JSON.parse(content);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const payload = await readJson(args.input);
  validatePayload(payload);

  const scoredComponents = payload.components
    .filter((component) => component.implemented)
    .map((component) => scoreImplementedComponent(component, payload))
    .sort((a, b) => b.score - a.score);

  const report = {
    meta: {
      generatedAt: new Date().toISOString(),
      inputFile: args.input
    },
    config: {
      version: payload.version,
      weights: payload.weights,
      dimensionWeights: payload.dimensionWeights,
      thresholds: payload.thresholds
    },
    summary: summarize(scoredComponents, payload.thresholds),
    components: scoredComponents
  };

  printConsoleReport(report);

  if (!args.stdout) {
    await writeFile(args.output, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.log(`Saved report to ${args.output}`);
  } else {
    console.log(JSON.stringify(report, null, 2));
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
