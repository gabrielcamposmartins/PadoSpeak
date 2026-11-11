// node --test client/src/lib/callFocus.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickAutoFocus, SWITCH_HOLD_MS } from './callFocus.js';

const me = (o = {}) => ({ id: 'me', self: true, ...o });
const peer = (id, o = {}) => ({ id, peerId: id, ...o });
const screen = (id, o = {}) => ({ id: `${id}:screen`, kind: 'screen', peerId: id, stream: {}, ...o });
const pick = (tiles, prev = null, since = 0, now = 10_000, phone = false) => pickAutoFocus({ tiles, prev, since, now, phone });

test('sem câmera nem transmissão: grade (no celular, alguém da chamada)', () => {
  const tiles = [me(), peer('a'), peer('b')];
  assert.equal(pick(tiles).id, null);
  assert.equal(pick(tiles, null, 0, 10_000, true).id, 'a');
});

test('a minha câmera não entra em destaque', () => {
  assert.equal(pick([me({ stream: {}, speaking: true }), peer('a')]).id, null);
});

test('alguém abre a câmera: ela entra em destaque', () => {
  assert.equal(pick([me(), peer('a'), peer('b', { stream: {} })]).id, 'b');
  // anunciada, esperando eu pedir para ver, também
  assert.equal(pick([me(), peer('a', { offer: 'camera' })]).id, 'a');
});

test('transmissão tem prioridade sobre câmera, mesmo de quem fala', () => {
  const tiles = [me(), peer('a', { stream: {}, speaking: true }), peer('b'), screen('b')];
  assert.equal(pick(tiles).id, 'b:screen');
  // a minha transmissão não conta
  assert.equal(pick([me(), screen('me', { self: true, id: 'me:screen' }), peer('a', { stream: {} })]).id, 'a');
});

test('a câmera em destaque é a de quem fala', () => {
  const tiles = [me(), peer('a', { stream: {} }), peer('b', { stream: {}, speaking: true })];
  assert.equal(pick(tiles).id, 'b');
  // a câmera de quem fala sem câmera não conta
  assert.equal(pick([me(), peer('a', { stream: {} }), peer('c', { speaking: true })], 'a', 0).id, 'a');
});

test('ninguém falando: fica em quem falou por último', () => {
  const tiles = [me(), peer('a', { stream: {} }), peer('b', { stream: {} })];
  assert.equal(pick(tiles, 'b', 0).id, 'b');
});

test('não pula a cada palavra: espera o intervalo antes de trocar', () => {
  const tiles = [me(), peer('a', { stream: {} }), peer('b', { stream: {}, speaking: true })];
  const early = pick(tiles, 'a', 9_000, 9_500);
  assert.equal(early.id, 'a');
  assert.equal(early.wait, SWITCH_HOLD_MS - 500);
  assert.deepEqual(pick(tiles, 'a', 9_000, 9_000 + SWITCH_HOLD_MS), { id: 'b', wait: 0 });
  // quem está em destaque continua falando junto com outro: fica
  const both = [me(), peer('a', { stream: {}, speaking: true }), peer('b', { stream: {}, speaking: true })];
  assert.equal(pick(both, 'a', 0).id, 'a');
});

test('quem estava em destaque desligou a câmera: vai para outra', () => {
  assert.equal(pick([me(), peer('a'), peer('b', { stream: {} })], 'a', 9_999).id, 'b');
});

test('duas transmissões: fica na mesma; uma nova vai para a de quem fala', () => {
  const tiles = [me(), peer('a', { speaking: true }), screen('a'), peer('b'), screen('b')];
  assert.equal(pick(tiles, 'b:screen').id, 'b:screen');
  assert.equal(pick(tiles).id, 'a:screen');
});
