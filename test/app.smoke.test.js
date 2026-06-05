import { describe, it, expect } from 'vitest';
import { createApp } from '../src/app.js';

describe('app scaffold', () => {
  it('serves a placeholder at GET /', async () => {
    const app = createApp({});
    const res = await app.request('/');
    expect(res.status).toBe(200);
  });
});
