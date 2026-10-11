const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

// Execute the actual backend response function and capture its Gemini request.
// Startup services, environment and HTTP are isolated; no .env or network access.
async function chatRequest(userContext) {
  const requests = [];
  const app = { use() {}, post() {}, get() {}, listen() {} };
  const express = Object.assign(() => app, { json: () => () => {} });
  const dependencies = {
    express,
    cors: () => () => {},
    'firebase-admin': { initializeApp() {}, credential: { cert: () => ({}) } },
    '@supabase/supabase-js': { createClient: () => ({}) },
    dotenv: { config() {} },
    'node-fetch': async (_url, options) => {
      const body = JSON.parse(options.body);
      requests.push(body);
      const text = requests.length === 1
        ? JSON.stringify({ intent: 'FITNESS_CHAT' })
        : 'Use your current training level and recovery status.';
      return {
        ok: true,
        json: async () => ({ candidates: [{ content: { parts: [{ text }] } }] }),
      };
    },
    './services/exerciseRankingService': require('../services/exerciseRankingService'),
    './services/muscleNormalizationService': require('../services/muscleNormalizationService'),
  };
  const runtime = {
    require(name) {
      assert.ok(Object.hasOwn(dependencies, name), `Unexpected dependency: ${name}`);
      return dependencies[name];
    },
    process: { env: { FIREBASE_PRIVATE_KEY: 'test-key', GEMINI_API_KEY: 'test-key' } },
    console: { log() {}, error() {}, warn() {} },
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('../index.js'), 'utf8'), runtime, {
    filename: 'index.js',
  });
  const result = await runtime.generateBotResponse('How should I train today?', 'test-user', {}, userContext);
  assert.equal(result.message, 'Use your current training level and recovery status.');
  assert.equal(requests.length, 2);
  return requests[1];
}

test('ordinary chat includes supplied profile along with actual history', async () => {
  const profile = { name: 'Maya', fitnessLevel: 'Fitness Architect', gender: 'Female' };
  const context = {
    userProfile: profile,
    lifetimeStats: { totalWorkoutsLogged: 5 },
    perMuscleGroupTelemetry: { chest: { fatigueStatus: 'Mild Fatigue' } },
    perExerciseMetrics: { Bench: { lastPerformance: { topWeightKg: 80 } } },
    recentWorkouts: [{ title: 'Latest Bench Session' }],
  };
  const request = await chatRequest(context);
  const prompt = request.system_instruction.parts[0].text;
  assert.ok(prompt.includes(JSON.stringify(profile)), 'Profile is missing from the actual Gemini request');
  for (const field of ['lifetimeStats', 'perMuscleGroupTelemetry', 'perExerciseMetrics', 'recentWorkouts']) {
    assert.ok(prompt.includes(JSON.stringify(context[field])), `${field} was dropped`);
  }
  assert.equal(request.contents[0].parts[0].text, 'How should I train today?');
});

test('ordinary chat with no cached context still returns a response', async () => {
  const request = await chatRequest({});
  assert.ok(!request.system_instruction.parts[0].text.includes('undefined'));
});

test('profile prompt contains only supported nonempty text fields', async () => {
  const request = await chatRequest({ userProfile: {
    name: '  Maya  ', fitnessLevel: 'Fitness Architect', gender: '',
    email: 'private@example.test', phone: 'private-phone', age: 22,
  } });
  const prompt = request.system_instruction.parts[0].text;
  assert.ok(prompt.includes(JSON.stringify({ name: 'Maya', fitnessLevel: 'Fitness Architect' })));
  assert.ok(!prompt.includes('private@example.test'));
  assert.ok(!prompt.includes('private-phone'));
  assert.ok(!prompt.includes('"gender":""'));
});

test('empty or malformed profiles do not add fictitious profile data', async () => {
  for (const userProfile of [null, '', {}, { name: 123, fitnessLevel: ' ', gender: false }]) {
    const request = await chatRequest({ userProfile });
    const prompt = request.system_instruction.parts[0].text;
    assert.ok(!prompt.includes('- User Profile:'));
    assert.ok(!prompt.includes('"fitnessLevel":"Intermediate"'));
  }
});

test('legacy fatigue and exercise telemetry remain supported', async () => {
  const context = { fatigueLevels: { chest: 1 }, exerciseRecords: { Bench: 80 } };
  const request = await chatRequest(context);
  const prompt = request.system_instruction.parts[0].text;
  assert.ok(prompt.includes(JSON.stringify(context.fatigueLevels)));
  assert.ok(prompt.includes(JSON.stringify(context.exerciseRecords)));
});
