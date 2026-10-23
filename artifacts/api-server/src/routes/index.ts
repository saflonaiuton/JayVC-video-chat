import { Router, type IRouter } from "express";
import healthRouter from "./health";
import jayvcRouter from "./jayvc";

const router: IRouter = Router();

router.use(healthRouter);
router.use(jayvcRouter);

export default router;
