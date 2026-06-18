import { describe, it, expect } from 'vitest';
import { classifyError, ERROR_PATTERNS, ERROR_CODES } from '../../src/jobs/error-classifier';

describe('error-classifier', () => {
  describe('classifyError — códigos nativos (err.code)', () => {
    it('clasifica ENOSPC como disk_full', () => {
      const err = new Error('No space left on device');
      err.code = 'ENOSPC';
      expect(classifyError(err)).toEqual({ type: 'disk_full', action: 'alert_disk' });
    });

    it('clasifica ENOENT como smb_disconnected', () => {
      const err = new Error('ENOENT: no such file or directory');
      err.code = 'ENOENT';
      expect(classifyError(err)).toEqual({ type: 'smb_disconnected', action: 'alert_smb' });
    });

    it('clasifica EACCES como smb_disconnected', () => {
      const err = new Error('Permission denied');
      err.code = 'EACCES';
      expect(classifyError(err)).toEqual({ type: 'smb_disconnected', action: 'alert_smb' });
    });

    it('clasifica EIO como smb_disconnected', () => {
      const err = new Error('I/O error');
      err.code = 'EIO';
      expect(classifyError(err)).toEqual({ type: 'smb_disconnected', action: 'alert_smb' });
    });

    it('clasifica ECONNRESET como network', () => {
      const err = new Error('Connection reset by peer');
      err.code = 'ECONNRESET';
      expect(classifyError(err)).toEqual({ type: 'network', action: 'retry' });
    });

    it('clasifica ETIMEDOUT como network', () => {
      const err = new Error('Connection timed out');
      err.code = 'ETIMEDOUT';
      expect(classifyError(err)).toEqual({ type: 'network', action: 'retry' });
    });

    it('clasifica ECONNREFUSED como smb_disconnected (prioridad code sobre message)', () => {
      const err = new Error('Connection refused');
      err.code = 'ECONNREFUSED';
      expect(classifyError(err)).toEqual({ type: 'smb_disconnected', action: 'alert_smb' });
    });

    it('código desconocido cae a fallback de message', () => {
      const err = new Error('Error accediendo a 1ACTIVOS/proyecto');
      err.code = 'EUNKNOWN_CODE';
      expect(classifyError(err)).toEqual({ type: 'smb_disconnected', action: 'alert_smb' });
    });
  });

  describe('classifyError — fallback a message', () => {
    it('clasifica errores de disco lleno con "espacio en disco"', () => {
      const err = new Error('No hay espacio en disco disponible');
      expect(classifyError(err)).toEqual({ type: 'disk_full', action: 'alert_disk' });
    });

    it('clasifica errores de disco lleno con "ENOSPC"', () => {
      const err = new Error('ENOSPC: no space left on device');
      expect(classifyError(err)).toEqual({ type: 'disk_full', action: 'alert_disk' });
    });

    it('clasifica errores SMB desconectado con "1ACTIVOS"', () => {
      const err = new Error('Error accediendo a 1ACTIVOS/proyecto');
      expect(classifyError(err)).toEqual({ type: 'smb_disconnected', action: 'alert_smb' });
    });

    it('clasifica errores SMB desconectado con "readdir"', () => {
      const err = new Error('EIO: readdir scandir failed');
      expect(classifyError(err)).toEqual({ type: 'smb_disconnected', action: 'alert_smb' });
    });

    it('clasifica errores SMB desconectado con "SMB"', () => {
      const err = new Error('SMB connection lost');
      expect(classifyError(err)).toEqual({ type: 'smb_disconnected', action: 'alert_smb' });
    });

    it('clasifica errores SMB desconectado con "TRABAJOS_BASE_PATH"', () => {
      const err = new Error('Cannot access TRABAJOS_BASE_PATH directory');
      expect(classifyError(err)).toEqual({ type: 'smb_disconnected', action: 'alert_smb' });
    });

    it('devuelve unknown para errores no reconocidos', () => {
      const err = new Error('Error genérico de red');
      expect(classifyError(err)).toEqual({ type: 'unknown', action: 'none' });
    });

    it('prioriza disco lleno sobre SMB si ambos patrones coinciden', () => {
      const err = new Error('ENOSPC: No hay espacio en disco ni SMB disponible');
      expect(classifyError(err).type).toBe('disk_full');
    });

    it('maneja errores con mensaje vacío', () => {
      const err = new Error('');
      expect(classifyError(err)).toEqual({ type: 'unknown', action: 'none' });
    });
  });

  describe('ERROR_CODES', () => {
    it('contiene códigos DISK_FULL como array no vacío', () => {
      expect(Array.isArray(ERROR_CODES.DISK_FULL)).toBe(true);
      expect(ERROR_CODES.DISK_FULL.length).toBeGreaterThan(0);
    });

    it('contiene códigos SMB_DISCONNECTED como array no vacío', () => {
      expect(Array.isArray(ERROR_CODES.SMB_DISCONNECTED)).toBe(true);
      expect(ERROR_CODES.SMB_DISCONNECTED.length).toBeGreaterThan(0);
    });

    it('contiene códigos NETWORK como array no vacío', () => {
      expect(Array.isArray(ERROR_CODES.NETWORK)).toBe(true);
      expect(ERROR_CODES.NETWORK.length).toBeGreaterThan(0);
    });
  });

  describe('ERROR_PATTERNS', () => {
    it('contiene patrones DISK_FULL como array no vacío', () => {
      expect(Array.isArray(ERROR_PATTERNS.DISK_FULL)).toBe(true);
      expect(ERROR_PATTERNS.DISK_FULL.length).toBeGreaterThan(0);
    });

    it('contiene patrones SMB_DISCONNECTED como array no vacío', () => {
      expect(Array.isArray(ERROR_PATTERNS.SMB_DISCONNECTED)).toBe(true);
      expect(ERROR_PATTERNS.SMB_DISCONNECTED.length).toBeGreaterThan(0);
    });
  });
});