import { describe, it, expect } from 'vitest';
import { isAllowedImageExtension, isAllowedEvidenceExtension, validateFileContent, ALLOWED_IMAGE_EXTENSIONS } from '../../src/utils/image-validator';

describe('image-validator', () => {
  describe('isAllowedEvidenceExtension', () => {
    it('acepta extensiones válidas en minúsculas', () => {
      const valid = ['.jpg', '.jpeg', '.png', '.webp', '.heic', '.heif', '.gif', '.bmp', '.tiff', '.tif', '.pdf'];
      for (const ext of valid) {
        expect(isAllowedEvidenceExtension(`foto${ext}`)).toBe(true);
      }
    });

    it('acepta PDF en mayúsculas y mixtas', () => {
      expect(isAllowedEvidenceExtension('acta.PDF')).toBe(true);
      expect(isAllowedEvidenceExtension('acta.PdF')).toBe(true);
    });

    it('rechaza extensiones no permitidas', () => {
      const invalid = ['.exe', '.sh', '.zip', '.docx', '.bat', '.cmd', '.ps1', '.js', '.html', '.mp4', '.avi'];
      for (const ext of invalid) {
        expect(isAllowedEvidenceExtension(`archivo${ext}`)).toBe(false);
      }
    });

    it('rechaza archivos sin extensión', () => {
      expect(isAllowedEvidenceExtension('archivo_sin_extension')).toBe(false);
    });

    it('rechaza nombres vacíos, null y undefined', () => {
      expect(isAllowedEvidenceExtension('')).toBe(false);
      expect(isAllowedEvidenceExtension(null)).toBe(false);
      expect(isAllowedEvidenceExtension(undefined)).toBe(false);
    });

    it('rechaza valores no string', () => {
      expect(isAllowedEvidenceExtension(123)).toBe(false);
      expect(isAllowedEvidenceExtension({})).toBe(false);
    });

    it('maneja correctamente nombres con múltiples puntos', () => {
      expect(isAllowedEvidenceExtension('foto.backup.jpg')).toBe(true);
      expect(isAllowedEvidenceExtension('archivo.tar.gz')).toBe(false);
    });
  });

  describe('isAllowedImageExtension (alias)', () => {
    it('es un alias de isAllowedEvidenceExtension', () => {
      expect(isAllowedImageExtension).toBe(isAllowedEvidenceExtension);
      expect(isAllowedImageExtension('foto.jpg')).toBe(true);
      expect(isAllowedImageExtension('acta.pdf')).toBe(true);
    });
  });

  describe('validateFileContent', () => {
    it('acepta un PDF válido (empieza con %PDF-)', () => {
      const validPdf = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\n%%EOF\n', 'latin1');
      expect(() => validateFileContent(validPdf, 'acta.pdf')).not.toThrow();
    });

    it('rechaza un fake PDF (no empieza con %PDF-)', () => {
      const fakePdf = Buffer.from('MZ\x90\x00\x03\x00\x00\x00\x04\x00\x00\x00', 'latin1');
      expect(() => validateFileContent(fakePdf, 'acta.pdf')).toThrow(/no es un PDF válido/);
    });

    it('rechaza un PDF truncado/vacío', () => {
      expect(() => validateFileContent(Buffer.alloc(0), 'acta.pdf')).not.toThrow();
    });

    it('no valida imágenes (pasa sin comprobar magic bytes)', () => {
      const fakeJpg = Buffer.from('not-an-image-at-all');
      expect(() => validateFileContent(fakeJpg, 'foto.jpg')).not.toThrow();
    });

    it('no hace nada para extensiones no-PDF', () => {
      expect(() => validateFileContent(Buffer.from('anything'), 'doc.txt')).not.toThrow();
      expect(() => validateFileContent(null, 'doc.txt')).not.toThrow();
    });
  });

  describe('ALLOWED_IMAGE_EXTENSIONS', () => {
    it('es un Set con las extensiones esperadas (incluye pdf)', () => {
      expect(ALLOWED_IMAGE_EXTENSIONS).toBeInstanceOf(Set);
      expect(ALLOWED_IMAGE_EXTENSIONS.size).toBe(11);
      expect(ALLOWED_IMAGE_EXTENSIONS.has('.jpg')).toBe(true);
      expect(ALLOWED_IMAGE_EXTENSIONS.has('.pdf')).toBe(true);
    });
  });
});
