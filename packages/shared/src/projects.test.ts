import { describe, expect, it } from 'vitest';
import { CreateProjectRequestSchema, UpdateProjectRequestSchema } from './projects.js';

describe('CreateProjectRequestSchema', () => {
  it('trims the name and keeps an optional docs folder path', () => {
    const request = CreateProjectRequestSchema.parse({ name: '  Fleet  ', docsFolderPath: '/work/fleet-docs' });

    expect(request).toEqual({ name: 'Fleet', docsFolderPath: '/work/fleet-docs' });
  });

  it('accepts a name alone', () => {
    expect(CreateProjectRequestSchema.parse({ name: 'Fleet' })).toEqual({ name: 'Fleet' });
  });

  it.each(['', '   ', 'x'.repeat(81)])('rejects the name %j', (name) => {
    expect(() => CreateProjectRequestSchema.parse({ name })).toThrow();
  });

  it('accepts an 80-character name', () => {
    expect(CreateProjectRequestSchema.parse({ name: 'x'.repeat(80) }).name).toHaveLength(80);
  });

  it('rejects an empty docs folder path and unknown keys', () => {
    expect(() => CreateProjectRequestSchema.parse({ name: 'Fleet', docsFolderPath: '' })).toThrow();
    expect(() => CreateProjectRequestSchema.parse({ name: 'Fleet', id: 'forced-id' })).toThrow();
  });
});

describe('UpdateProjectRequestSchema', () => {
  it('accepts a name, a docs folder path or both', () => {
    expect(UpdateProjectRequestSchema.parse({ name: ' Renamed ' })).toEqual({ name: 'Renamed' });
    expect(UpdateProjectRequestSchema.parse({ docsFolderPath: '/work/docs' })).toEqual({ docsFolderPath: '/work/docs' });
    expect(UpdateProjectRequestSchema.parse({ name: 'N', docsFolderPath: '/work/docs' })).toEqual({ name: 'N', docsFolderPath: '/work/docs' });
  });

  it('refuses an empty patch, a blank name and unknown keys', () => {
    expect(() => UpdateProjectRequestSchema.parse({})).toThrow();
    expect(() => UpdateProjectRequestSchema.parse({ name: '  ' })).toThrow();
    expect(() => UpdateProjectRequestSchema.parse({ name: 'N', createdAt: 'x' })).toThrow();
  });
});
