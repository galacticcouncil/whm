import * as winston from "winston";

export default winston.createLogger({
  transports: [new winston.transports.Console({ level: process.env.LOG_LEVEL || "info" })],
  format: winston.format.combine(
    winston.format.colorize(),
    winston.format.splat(),
    winston.format.simple(),
    winston.format.errors({ stack: true }),
  ),
});
