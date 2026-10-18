import type { FastifyReply, FastifyRequest } from 'fastify';
import type { SignedInUser } from '../auth.ts';

/** Every refusal has the same shape: a code for programs, plain words for people. */
export function fail(reply: FastifyReply, status: number, error: string, message: string, extra: object = {}) {
  return reply.code(status).send({ error, message, ...extra });
}

/** Routes marked auth: 'required' run only after the auth hook set the user. */
export function signedIn(req: FastifyRequest): SignedInUser {
  if (!req.user) throw new Error('auth-required route ran without a user');
  return req.user;
}

export const pgCode = (err: unknown) => (err as { code?: string }).code;
export const pgConstraint = (err: unknown) => (err as { constraint?: string }).constraint;
