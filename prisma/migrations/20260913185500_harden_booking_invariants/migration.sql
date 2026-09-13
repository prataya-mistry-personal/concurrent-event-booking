-- AlterEnum
-- Abandoned and user-released holds need terminal states. Without them a lapsed
-- hold stays PENDING forever and is indistinguishable from a live one.
-- Postgres 12+ permits ADD VALUE inside a transaction as long as the new value
-- is not used in the same transaction, which is the case here.
ALTER TYPE "BookingStatus" ADD VALUE 'EXPIRED';
ALTER TYPE "BookingStatus" ADD VALUE 'CANCELLED';

-- AlterTable
-- Fence token mirroring the Redis lock value, so releasing a lock requires
-- proving ownership rather than merely knowing the seat id.
ALTER TABLE "Booking" ADD COLUMN     "hold_token" TEXT;

-- CreateIndex
-- Postgres does not index foreign keys automatically.
CREATE INDEX "Booking_seat_id_idx" ON "Booking"("seat_id");

-- CreateIndex
-- Drives the reaper's sweep for holds past their deadline.
CREATE INDEX "Booking_status_expires_at_idx" ON "Booking"("status", "expires_at");

-- CreateIndex
-- Serves both the seat map and the availability count.
CREATE INDEX "Seat_event_id_status_idx" ON "Seat"("event_id", "status");

-- CreateIndex
-- Re-seeding must not silently duplicate a seat label within one event.
CREATE UNIQUE INDEX "Seat_event_id_label_key" ON "Seat"("event_id", "label");

-- CreateIndex (raw SQL: Prisma cannot express filtered unique indexes for Postgres)
--
-- The storage-level backstop for the invariant that actually matters: a seat can
-- never have two CONFIRMED bookings. This holds even if the application logic
-- regresses, and it is what makes the correctness guarantee independent of
-- Redis availability or controller code paths.
--
-- Deliberately scoped to CONFIRMED only. An equivalent index on PENDING would
-- also prevent duplicate *holds*, but holds are soft state that the application
-- manages via a guarded conditional claim plus lazy reclaim, and enforcing them
-- in the database would mask the very oversell behaviour the naive comparison
-- endpoints exist to demonstrate.
CREATE UNIQUE INDEX "Booking_one_confirmed_per_seat"
    ON "Booking"("seat_id")
    WHERE "status" = 'CONFIRMED';
