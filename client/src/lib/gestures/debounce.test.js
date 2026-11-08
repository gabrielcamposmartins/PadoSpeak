// node --test client/src/lib/gestures/debounce.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGestureFilter } from './debounce.js';

/** Manda `ms` de quadros (a cada `step` ms) com o mesmo palpite; devolve o que valeu. */
function hold(f, gesture, score, from, ms, step = 100, wrist = null) {
  const fired = [];
  for (let t = from; t <= from + ms; t += step) {
    const out = f.push({ gesture, score, wrist: typeof wrist === 'function' ? wrist(t) : wrist }, t);
    if (out) fired.push([out, t]);
  }
  return fired;
}

test('segurar o joinha vale uma vez só', () => {
  const f = createGestureFilter();
  const fired = hold(f, 'Thumb_Up', 0.9, 0, 2000);
  assert.equal(fired.length, 1);
  assert.equal(fired[0][0], 'Thumb_Up');
  assert.ok(fired[0][1] >= 450 && fired[0][1] <= 700, `valeu em ${fired[0][1]} ms`);
});

test('confiança baixa ou gesto rápido não valem', () => {
  const f = createGestureFilter();
  assert.equal(hold(f, 'Thumb_Up', 0.5, 0, 1500).length, 0);
  const g = createGestureFilter();
  assert.equal(hold(g, 'Victory', 0.9, 0, 300).length, 0);
});

test('ruído no meio não impede; punho fechado e palma parada são ignorados', () => {
  const f = createGestureFilter();
  let fired = null;
  for (let t = 0; t <= 1000; t += 100) {
    const out = f.push({ gesture: t === 300 ? 'None' : 'ILoveYou', score: 0.85 }, t);
    if (out) fired = out;
  }
  assert.equal(fired, 'ILoveYou');
  const g = createGestureFilter();
  assert.equal(hold(g, 'Closed_Fist', 0.95, 0, 2000).length, 0);
  assert.equal(hold(g, 'Open_Palm', 0.95, 3000, 2000, 100, { x: 0.5, y: 0.5 }).length, 0);
});

test('o mesmo gesto só vale de novo depois de sumir e do intervalo', () => {
  const f = createGestureFilter();
  assert.equal(hold(f, 'Thumb_Up', 0.9, 0, 800).length, 1);
  hold(f, 'None', 0, 900, 600);
  // sumiu, mas ainda dentro dos 3 s do mesmo gesto
  assert.equal(hold(f, 'Thumb_Up', 0.9, 1600, 800).length, 0);
  hold(f, 'None', 0, 2500, 600);
  assert.equal(hold(f, 'Thumb_Up', 0.9, 3200, 900).length, 1);
});

test('dois gestos diferentes precisam de 1 s entre eles', () => {
  const f = createGestureFilter();
  assert.equal(hold(f, 'Thumb_Up', 0.9, 0, 700).length, 1);
  const fired = hold(f, 'Victory', 0.9, 700, 1200);
  assert.equal(fired.length, 1);
  assert.ok(fired[0][1] >= 1500, `o segundo valeu em ${fired[0][1]} ms`);
});

test('aceno: palma aberta indo e voltando', () => {
  const f = createGestureFilter();
  // ~2 idas e voltas por segundo, amplitude 0,1
  const fired = hold(f, 'Open_Palm', 0.9, 0, 1500, 80, (t) => ({ x: 0.5 + 0.1 * Math.sin((t / 1000) * 2 * Math.PI * 2), y: 0.5 }));
  assert.equal(fired.length, 1);
  assert.equal(fired[0][0], 'wave');
  // palma parada não é aceno
  const g = createGestureFilter();
  assert.equal(hold(g, 'Open_Palm', 0.9, 0, 1500, 80, (t) => ({ x: 0.5 + 0.01 * Math.sin(t / 100), y: 0.5 })).length, 0);
});

test('aparelho lento (2 quadros por segundo): o gesto segurado ainda vale', () => {
  const f = createGestureFilter();
  const fired = hold(f, 'Thumb_Up', 0.9, 0, 3000, 500);
  assert.equal(fired.length, 1);
  assert.equal(fired[0][0], 'Thumb_Up');
});
