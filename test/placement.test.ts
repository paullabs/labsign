// Geometria do posicionamento (módulo compartilhado entre servidor e tela).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { frameFromPlacement, boxInFrame, fitPlacement, clampFrame, resizeFrame, scaleFrame } from '../src/core/placement.ts';

const near = (a: number, b: number, tol = 1e-6) => Math.abs(a - b) <= tol;
const onLine = { pageIndex: 1, x: 80, bottom: 607, width: 170, maxHeight: 55 }; // "sentada" na linha
const page = { width: 595.28, height: 841.89 };

test('assinatura larga ocupa a largura toda e senta na linha', () => {
  const b = fitPlacement(onLine, 0.3);
  assert.ok(near(b.width, 170) && near(b.height, 51) && near(b.y + b.height, 607));
});

test('assinatura alta encolhe até caber em 55 pt de altura', () => {
  const b = fitPlacement(onLine, 81 / 170);
  assert.ok(near(b.height, 55) && b.width < 170 && near(b.y + b.height, 607));
});

test('posição explícita respeita o topo e a largura', () => {
  const b = fitPlacement({ pageIndex: 0, x: 10, y: 20, width: 100 }, 0.5);
  assert.ok(near(b.x, 10) && near(b.y, 20) && near(b.width, 100) && near(b.height, 50));
});

test('alternar assinaturas volta ao mesmo tamanho (a moldura não encolhe)', () => {
  const f = frameFromPlacement(onLine);
  const a1 = boxInFrame(f, 0.6), a2 = boxInFrame(f, 0.2), a3 = boxInFrame(f, 0.6);
  assert.ok(near(a1.width, a3.width) && near(a1.height, a3.height) && a2.width > a1.width);
});

test('arrastar para fora da página é contido na borda', () => {
  const b = boxInFrame(clampFrame({ ...frameFromPlacement(onLine), x: 560, y: -40 }, 0.3, page), 0.3);
  assert.ok(b.x >= 0 && b.y >= 0 && near(b.x + b.width, page.width, 1e-9) && near(b.y, 0, 1e-9));
});

test('redimensionar pelo canto mantém o canto superior esquerdo', () => {
  const f = frameFromPlacement(onLine);
  const before = boxInFrame(f, 0.3);
  const after = boxInFrame(resizeFrame(f, 0.3, 240), 0.3);
  assert.ok(near(before.x, after.x) && near(before.y, after.y) && near(after.width, 240));
});

test('+/− no teclado mantém a assinatura sentada na linha', () => {
  const b = boxInFrame(scaleFrame(frameFromPlacement(onLine), 1.2), 0.3);
  assert.ok(near(b.y + b.height, 607) && near(b.width, 170 * 1.2));
});
