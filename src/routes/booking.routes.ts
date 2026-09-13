import { Router } from 'express';
import {
  checkoutSeat,
  getBooking,
  holdSeat,
  releaseSeat,
} from '../controllers/booking.controller';
import {
  checkoutSeatNaive,
  holdSeatNaive,
} from '../controllers/booking.naive.controller';

const router = Router();

// Hardened path.
router.post('/hold', holdSeat);
router.post('/checkout', checkoutSeat);
router.post('/release', releaseSeat);

// Intentionally unsafe path, kept alongside the real one so the demo can compare
// both without restarting. See booking.naive.controller.ts.
router.post('/hold-naive', holdSeatNaive);
router.post('/checkout-naive', checkoutSeatNaive);

// Declared last so it cannot shadow the literal routes above.
router.get('/:id', getBooking);

export default router;
