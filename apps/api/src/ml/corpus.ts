// What Graphinity's own models may learn from: the public questions and
// answers of people who turned on "model_training" (migration 0015), never
// anything hidden by moderation, never private data. Read in a system
// transaction, so the consent rows of every person are visible to the job and
// to nothing else.
import { createHash } from 'node:crypto';
import type { Database } from '../db.ts';

export interface CorpusQuestion {
  id: string;
  title: string;
  body: string;
}

export interface Corpus {
  questions: CorpusQuestion[];
  /** Answers with the id of their question, for the held-out split. */
  answers: Array<{ questionId: string; body: string }>;
  /** A hash of exactly which records (ids, not text) are in it. */
  fingerprint: string;
}

/** Bounds a training run's memory: the newest this many of each are used. */
export const MAX_QUESTIONS = 50_000;
export const MAX_ANSWERS = 150_000;

export async function loadCorpus(db: Pick<Database, 'asSystem'>): Promise<Corpus> {
  return db.asSystem(async q => {
    const questions = (
      await q.query<CorpusQuestion>(
        `SELECT q.id::text AS id, q.title, q.body FROM app.questions q
         JOIN app.user_consent_settings s ON s.user_id = q.asker_id AND s.category = 'model_training' AND s.enabled
         WHERE NOT app.is_question_hidden(q.id)
         ORDER BY q.id DESC LIMIT ${String(MAX_QUESTIONS)}`,
      )
    ).rows;
    const answers = (
      await q.query<{ id: string; questionId: string; body: string }>(
        `SELECT a.id::text AS id, a.question_id::text AS "questionId", a.body FROM app.answers a
         JOIN app.user_consent_settings s ON s.user_id = a.answerer_id AND s.category = 'model_training' AND s.enabled
         WHERE NOT app.is_answer_hidden(a.id) AND NOT app.is_question_hidden(a.question_id)
         ORDER BY a.id DESC LIMIT ${String(MAX_ANSWERS)}`,
      )
    ).rows;
    const hash = createHash('sha256');
    for (const x of questions) hash.update(`q${x.id};`);
    for (const x of answers) hash.update(`a${x.id};`);
    return {
      questions,
      answers: answers.map(a => ({ questionId: a.questionId, body: a.body })),
      fingerprint: hash.digest('hex'),
    };
  });
}
