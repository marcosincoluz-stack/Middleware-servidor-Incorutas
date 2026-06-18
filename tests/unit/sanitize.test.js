import { describe, it, expect } from 'vitest';
import { sanitizeFilename, ensurePathWithinBase } from '../../src/utils/sanitize';

describe('sanitizeFilename', () => {
  it('debería reemplazar caracteres prohibidos por guiones bajos', () => {
    expect(sanitizeFilename('file<>:name.pdf')).toBe('file___name.pdf');
  });

  it('debería eliminar caracteres de control', () => {
    expect(sanitizeFilename('file\x00\x01name.pdf')).toBe('filename.pdf');
  });

  it('debería manejar null y undefined devolviendo string vacío', () => {
    expect(sanitizeFilename(null)).toBe('');
    expect(sanitizeFilename(undefined)).toBe('');
    expect(sanitizeFilename(123)).toBe('');
  });

  it('debería reemplazar múltiples espacios por uno solo', () => {
    expect(sanitizeFilename('my   file.txt')).toBe('my file.txt');
  });

  it('debería devolver nombre por defecto para strings vacíos y puntos', () => {
    expect(sanitizeFilename('')).toBe('archivo_sin_nombre');
    expect(sanitizeFilename('.')).toBe('archivo_sin_nombre');
    expect(sanitizeFilename('..')).toBe('archivo_sin_nombre');
  });

  it('debería manejar nombres con barras y contrabarras', () => {
    expect(sanitizeFilename('path/to\\file.pdf')).toBe('path_to_file.pdf');
  });

  it('debería manejar nombres muy largos', () => {
    const longName = 'a'.repeat(500) + '.pdf';
    const result = sanitizeFilename(longName);
    expect(result).toBeTruthy();
    expect(result.length).toBeGreaterThan(0);
  });
});

describe('ensurePathWithinBase', () => {
  const basePath = process.platform === 'win32' ? 'C:\\Users\\test\\trabajos' : '/mnt/trabajos';

  it('debería aceptar rutas dentro de la base', () => {
    const result = ensurePathWithinBase(
      process.platform === 'win32' ? 'C:\\Users\\test\\trabajos\\project' : '/mnt/trabajos/project',
      basePath
    );
    expect(result).toBeTruthy();
  });

  it('debería lanzar error para path traversal con ..', () => {
    const malicious = process.platform === 'win32'
      ? 'C:\\Users\\test\\trabajos\\..\\..\\etc\\passwd'
      : '/mnt/trabajos/../../etc/passwd';

    expect(() => ensurePathWithinBase(malicious, basePath)).toThrow(/Path Traversal/);
  });

  it('debería aceptar la ruta base exacta', () => {
    const result = ensurePathWithinBase(basePath, basePath);
    expect(result).toBe(basePath);
  });
});