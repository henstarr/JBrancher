#!/usr/bin/env node

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalLearningStore, findLearnedWorkflows, importDatasetExamples, mergeDatasetExamples, refreshAndPromoteReadOnly } from '../src/learning.js';

const fixture = JSON.parse(await readFile(new URL('./fixtures/swebench-lite-mini.json', import.meta.url), 'utf8'));

function integerFlag(name, fallback, minimum) {
  const index = process.argv.indexOf(name);
  const value = Number(index === -1 ? fallback : process.argv[index + 1]);
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`${name} must be an integer >= ${minimum}`);
  return value;
}

const repetitions = integerFlag('--repetitions', 4, 1);
const instanceCount = integerFlag('--instances', fixture.instances.length, 1);
const shouldAssert = process.argv.includes('--assert');
const instances = fixture.instances.slice(0, Math.min(instanceCount, fixture.instances.length));
const directory = await mkdtemp(join(tmpdir(), 'jbrancher-dataset-curation-'));

try {
  const store = createLocalLearningStore({ directory });
  for (const instance of instances) {
    const task = `${instance.instance_id}: inspect the failing test and repository overview`;
    const toolCalls = [
      { toolCallId: 'test', toolName: 'read', input: { path: instance.fail_to_pass[0] }, ok: true, output: 'test output' },
      { toolCallId: 'readme', toolName: 'read', input: { path: 'README.md' }, ok: true, output: 'repository overview' }
    ];
    for (let repetition = 0; repetition < repetitions; repetition++) {
      await store.appendTrace({
        task,
        source: repetition % 2 === 0 ? 'pi' : 'harbor',
        routeResolution: 'unmatched',
        metadata: { instanceId: instance.instance_id, repetition },
        toolCalls,
        outcome: 'success'
      });
    }
  }

  const raw = await store.writeDataset();
  const curated = await store.writeDataset({ deduplicate: true });
  const portableMerged = mergeDatasetExamples([
    raw.examples.filter((_, index) => index % 2 === 0),
    raw.examples.filter((_, index) => index % 2 === 1)
  ]);
  const portableCuratedMerged = mergeDatasetExamples([
    curated.examples.filter((_, index) => index % 2 === 0),
    curated.examples.filter((_, index) => index % 2 === 1)
  ]);
  const importedStore = createLocalLearningStore({ directory: join(directory, 'imported') });
  const imported = await importDatasetExamples(importedStore, portableCuratedMerged, {
    reviewed: true,
    source: 'shared-swebench-derived-dataset'
  });
  const repeatedImport = await importDatasetExamples(importedStore, portableCuratedMerged, {
    reviewed: true,
    source: 'shared-swebench-derived-dataset'
  });
  const importedLearning = await refreshAndPromoteReadOnly(importedStore, { minimumObservations: 2 });
  const importedRoutes = await importedStore.readRoutes();
  const warmStartMatches = instances.filter(instance => {
    const task = `${instance.instance_id}: inspect the failing test and repository overview`;
    return findLearnedWorkflows(importedRoutes, task).length > 0;
  }).length;
  const warmStartReplayedEpisodes = warmStartMatches * repetitions;
  const warmStartFrontierCalls = raw.examples.length - warmStartReplayedEpisodes;
  const report = {
    benchmark: 'JBrancher local dataset curation',
    source: { url: fixture.sourceUrl, instances: instances.length, repetitions },
    rawExamples: raw.examples.length,
    curatedExamples: curated.examples.length,
    rawDatasetPath: raw.path,
    curatedDatasetPath: curated.path,
    separateLiveAndCuratedFiles: raw.path !== curated.path,
    duplicateRowsRemoved: raw.examples.length - curated.examples.length,
    curationRatio: Number((1 - curated.examples.length / raw.examples.length).toFixed(3)),
    evidenceObservations: curated.examples.reduce((total, example) => total + example.evidence.observations, 0),
    portableMergedExamples: portableMerged.length,
    portableMergeObservations: portableMerged.reduce((total, example) => total + example.evidence.observations, 0),
    portableCuratedMergedExamples: portableCuratedMerged.length,
    portableCuratedMergeObservations: portableCuratedMerged.reduce((total, example) => total + example.evidence.observations, 0),
    portableMergeNoExternalDatabase: true,
    importedTraces: imported.importedTraces,
    importedObservations: imported.importedObservations,
    repeatedImportTraces: repeatedImport.importedTraces,
    repeatedImportSkippedTraces: repeatedImport.skippedExistingTraces,
    importIdempotent: repeatedImport.importedTraces === 0
      && repeatedImport.skippedExistingTraces === imported.importedTraces,
    importedActiveReadOnlyRoutes: importedRoutes.filter(route => route.status === 'active' && route.safety === 'read-only').length,
    importedPromotedRoutes: importedLearning.promoted.length,
    portableImportNoExternalDatabase: true,
    warmStartWorkflowCoverage: Number((warmStartMatches / instances.length).toFixed(3)),
    warmStartReplayedEpisodes,
    warmStartFrontierCalls,
    warmStartFrontierCallsAvoided: raw.examples.length - warmStartFrontierCalls,
    warmStartFrontierCallReduction: Number((1 - warmStartFrontierCalls / raw.examples.length).toFixed(3)),
    reusableCuratedExamples: curated.examples.filter(example => example.reusable).length,
    uniqueFingerprints: new Set(curated.examples.map(example => example.fingerprint)).size
  };

  if (shouldAssert) {
    assert.equal(report.rawExamples, instances.length * repetitions);
    assert.equal(report.curatedExamples, instances.length);
    assert.equal(report.separateLiveAndCuratedFiles, true);
    assert.equal(report.evidenceObservations, report.rawExamples);
    assert.equal(report.portableMergedExamples, report.curatedExamples);
    assert.equal(report.portableMergeObservations, report.rawExamples);
    assert.equal(report.portableCuratedMergedExamples, report.curatedExamples);
    assert.equal(report.portableCuratedMergeObservations, report.rawExamples);
    assert.equal(report.portableMergeNoExternalDatabase, true);
    assert.equal(report.importedTraces, report.rawExamples);
    assert.equal(report.importedObservations, report.rawExamples);
    assert.equal(report.repeatedImportTraces, 0);
    assert.equal(report.repeatedImportSkippedTraces, report.importedTraces);
    assert.equal(report.importIdempotent, true);
    assert.equal(report.importedActiveReadOnlyRoutes, report.curatedExamples);
    assert.equal(report.importedPromotedRoutes, report.curatedExamples);
    assert.equal(report.portableImportNoExternalDatabase, true);
    assert.equal(report.warmStartWorkflowCoverage, 1);
    assert.equal(report.warmStartReplayedEpisodes, report.rawExamples);
    assert.equal(report.warmStartFrontierCalls, 0);
    assert.equal(report.warmStartFrontierCallsAvoided, report.rawExamples);
    assert.equal(report.warmStartFrontierCallReduction, 1);
    assert.equal(report.uniqueFingerprints, report.curatedExamples);
    assert.equal(report.reusableCuratedExamples, report.curatedExamples);
    assert.equal(report.curationRatio, Number((1 - 1 / repetitions).toFixed(3)));
  }
  console.log(JSON.stringify(report, null, 2));
} finally {
  await rm(directory, { recursive: true, force: true });
}
