import { Router } from 'express';
import { getEvents, getEventSeats, getEventStats } from '../controllers/event.controller';

const router = Router();

router.get('/', getEvents);
router.get('/:id/seats', getEventSeats);
router.get('/:id/stats', getEventStats);

export default router;
