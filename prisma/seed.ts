import { prisma } from '../src/db/prisma';

const EVENT_NAME = 'Tech Conference 2026';
const SEAT_COUNT = 100;

/**
 * Idempotent: re-running must not duplicate the event or its seats. Seat labels
 * are now unique per event, so a second run would otherwise fail outright.
 */
async function main() {
  const existing = await prisma.event.findFirst({ where: { name: EVENT_NAME } });

  const event =
    existing ??
    (await prisma.event.create({
      data: {
        name: EVENT_NAME,
        total_seats: SEAT_COUNT,
        start_time: new Date('2026-10-15T09:00:00Z'),
      },
    }));

  const created = await prisma.seat.createMany({
    data: Array.from({ length: SEAT_COUNT }, (_, i) => ({
      event_id: event.id,
      label: `Seat ${i + 1}`,
      status: 'AVAILABLE' as const,
      version: 1,
    })),
    skipDuplicates: true,
  });

  const total = await prisma.seat.count({ where: { event_id: event.id } });

  console.log(
    `Event "${event.name}" (${event.id}): ${total} seats present (${created.count} created this run).`
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
