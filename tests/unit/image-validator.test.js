import { describe, it, expect } from 'vitest';
import { isAllowedImageExtension, ALLOWED_IMAGE_EXTENSIONS } from '../../src/utils/image-validator';

describe('image-validator', () => {
  describe('isAllowedImageExtension', () => {
    it('acepta extensiones válidas en minúsculas', () => {
      const valid = ['.jpg', '.jpeg', '.png', '.webp', '.heic', '.heif', '.gif', '.bmp', '.tiff', '.tif'];
      for (const ext of valid) {
        expect(isAllowedImageExtension(`foto${ext}`)).toBe(true);
      }
    });

    it('acepta extensiones válidas en mayúsculas', () => {
      expect(isAllowedImageExtension('foto.JPG')).toBe(true);
      expect(isAllowedImageExtension('foto.PNG')).toBe(true);
      expect(isAllowedImageExtension('foto.HEIC')).toBe(true);
      expect(isAllowedImageExtension('foto.WEBP')).toBe(true);
      expect(isAllowedImageExtension('foto.TIFF')).toBe(true);
    });

    it('acepta extensiones con mayúsculas mixtas', () => {
      expect(isAllowedImageExtension('foto.JpG')).toBe(true);
      expect(isAllowedImageExtension('foto.Png')).toBe(true);
      expect(isAllowedImageExtension('foto.HeIc')).toBe(true);
    });

    it('rechaza extensiones no permitidas', () => {
      const invalid = ['.exe', '.pdf', '.sh', '.zip', '.docx', '.bat', '.cmd', '.ps1', '.js', '.html', '.mp4', '.avi'];
      for (const ext of invalid) {
        expect(isAllowedImageExtension(`archivo${ext}`)).toBe(false);
      }
    });

    it('rechaza archivos sin extensión', () => {
      expect(isAllowedImageExtension('archivo_sin_extension')).toBe(false);
    });

    it('rechaza nombres vacíos, null y undefined', () => {
      expect(isAllowedImageExtension('')).toBe(false);
      expect(isAllowedImageExtension(null)).toBe(false);
      expect(isAllowedImageExtension(undefined)).toBe(false);
    });

    it('rechaza valores no string', () => {
      expect(isAllowedImageExtension(123)).toBe(false);
      expect(isAllowedImageExtension({})).toBe(false);
    });

    it('maneja correctamente nombres con múltiples puntos', () => {
      expect(isAllowedImageExtension('foto.backup.jpg')).toBe(true);
      expect(isAllowedImageExtension('archivo.tar.gz')).toBe(false);
    });

    it('rechaza extensiones similares pero no exactas', () => {
      expect(isAllowedImageExtension('foto.jpgg')).toBe(false);
      expect(isAllowedImageExtension('foto.pngg')).toBe(false);
      expect(isAllowedImageExtension('foto.jp')).toBe(false);
    });
  });

  describe('ALLOWED_IMAGE_EXTENSIONS', () => {
    it('es un Set con las extensiones esperadas', () => {
      expect(ALLOWED_IMAGE_EXTENSIONS).toBeInstanceOf(Set);
      expect(ALLOWED_IMAGE_EXTENSIONS.size).toBe(10);
      expect(ALLOWED_IMAGE_EXTENSIONS.has('.jpg')).toBe(true);
      expect(ALLOWED_IMAGE_EXTENSIONS.has('.jpeg')).toBe(true);
      expect(ALLOWED_IMAGE_EXTENSIONS.has('.png')).toBe(true);
    });
  });
});
