import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getJson, resetState, seedEvent, startTestServer, stopTestServer } from './helpers/env';

describe('read endpoints', () => {
  beforeAll(async () => {
    await startTestServer();
  });

  afterAll(async () => {
    await stopTestServer();
  });

  beforeEach(async () => {
    await resetState();
  });

  it('reports health', async () => {
    const res = await getJson('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  it('lists events with an accurate available seat count', async () => {
    const { eventId } = await seedEvent(100);

    const res = await getJson('/events');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].id).toBe(eventId);
    expect(res.body[0].available_seats).toBe(100);
  });

  it('returns an event seat map ordered by id', async () => {
    const { eventId, seatIds } = await seedEvent(100);

    const res = await getJson(`/events/${eventId}/seats`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(100);
    expect(res.body.map((s: any) => s.id)).toEqual(seatIds);
    expect(res.body.every((s: any) => s.status === 'AVAILABLE')).toBe(true);
  });
});
