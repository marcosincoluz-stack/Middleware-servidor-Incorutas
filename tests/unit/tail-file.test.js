import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { tailFile } from '../../src/utils/tail-file';

describe('tailFile', () => {
  let tmpDir;
  let tmpFile;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tailfile-test-'));
    tmpFile = path.join(tmpDir, 'test.log');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('retorna array vacío si el archivo no existe', async () => {
    const result = await tailFile(path.join(tmpDir, 'nonexistent.log'));
    expect(result).toEqual([]);
  });

  it('retorna array vacío si el archivo está vacío', async () => {
    fs.writeFileSync(tmpFile, '');
    const result = await tailFile(tmpFile);
    expect(result).toEqual([]);
  });

  it('retorna todas las líneas si el archivo es menor que maxBytes', async () => {
    const lines = Array.from({ length: 10 }, (_, i) => `Línea ${i + 1}`);
    fs.writeFileSync(tmpFile, lines.join('\n'));
    const result = await tailFile(tmpFile, { maxBytes: 1024, maxLines: 60 });
    expect(result).toEqual(lines);
  });

  it('retorna solo las últimas maxLines líneas', async () => {
    const lines = Array.from({ length: 100 }, (_, i) => `Línea ${i + 1}`);
    fs.writeFileSync(tmpFile, lines.join('\n'));
    const result = await tailFile(tmpFile, { maxBytes: 10240, maxLines: 5 });
    expect(result).toEqual(['Línea 96', 'Línea 97', 'Línea 98', 'Línea 99', 'Línea 100']);
  });

  it('lee solo el último fragmento cuando el archivo excede maxBytes', async () => {
    const longLine = 'A'.repeat(200);
    const lines = Array.from({ length: 500 }, (_, i) => `${longLine} ${i}`);
    fs.writeFileSync(tmpFile, lines.join('\n'));
    const result = await tailFile(tmpFile, { maxBytes: 5000, maxLines: 60 });
    expect(result.length).toBeLessThan(500);
    expect(result.length).toBeGreaterThan(0);
    expect(result[result.length - 1]).toContain('499');
  });

  it('filtra líneas vacías', async () => {
    fs.writeFileSync(tmpFile, 'línea 1\n\n\nlínea 2\n\nlínea 3\n');
    const result = await tailFile(tmpFile);
    expect(result).toEqual(['línea 1', 'línea 2', 'línea 3']);
  });

  it('usa valores por defecto si no se pasan opciones', async () => {
    const lines = Array.from({ length: 5 }, (_, i) => `line ${i}`);
    fs.writeFileSync(tmpFile, lines.join('\n'));
    const result = await tailFile(tmpFile);
    expect(result.length).toBe(5);
  });

  it('saltar primera línea parcial cuando lee desde offset', async () => {
    const lineContent = 'B'.repeat(100);
    const lines = Array.from({ length: 50 }, (_, i) => `${lineContent} ${i}`);
    fs.writeFileSync(tmpFile, lines.join('\n'));
    const result = await tailFile(tmpFile, { maxBytes: 500, maxLines: 60 });
    expect(result.length).toBeGreaterThan(0);
    for (const line of result) {
      expect(line.startsWith('B'.repeat(100))).toBe(true);
    }
  });
});