import { experienceQuestion, quickOptions, unavailable } from '@melete/contracts';
import { and, eq, isNull, or } from 'drizzle-orm';
import type { Sql } from 'postgres';
import { ServiceError } from '../api/errors.ts';
import type { Database } from '../db/client.ts';
import { job, question } from '../db/schema.ts';
import type { QuestionService } from '../jobs/questions.ts';
import { ownedSpace, ownJob } from '../principals/authority.ts';
import { explainHandles } from './evidence.ts';
import { plainText } from './projectors.ts';
import { experienceMissing } from './service.ts';

export class ExperienceQuestions {
  constructor(
    readonly db: Database,
    readonly questions?: QuestionService,
    readonly sql?: Sql,
  ) {}
  async find(spaceId: string, id?: string) {
    return this.db
      .select({ question })
      .from(question)
      .leftJoin(job, eq(job.id, question.jobId))
      .where(
        and(
          // A job's question is its owner's; one without a job belongs to the space owner.
          or(
            and(eq(job.spaceId, spaceId), ownJob()),
            and(
              isNull(question.jobId),
              eq(question.spaceId, spaceId),
              ownedSpace(question.spaceId),
            ),
          ),
          id ? eq(question.id, id) : eq(question.state, 'open'),
        ),
      )
      .orderBy(question.createdAt)
      .limit(200);
  }
  async list(spaceId: string) {
    const items = [];
    for (const { question: row } of await this.find(spaceId)) {
      const why = this.sql ? await explainHandles(this.sql, spaceId, row.because) : [];
      items.push(
        experienceQuestion.parse({
          id: row.id,
          conversation_id: row.jobId,
          text: plainText(row.text, 'Which option would you prefer?'),
          why,
          if_ignored: plainText(row.ifIgnored, 'This will wait for your answer.'),
          options: quickOptions
            .parse(row.options)
            .map((option) => ({ ...option, label: plainText(option.label, 'Choose this option') })),
        }),
      );
    }
    return { questions: items };
  }
  async answer(spaceId: string, id: string, optionId: string) {
    const [entry] = await this.find(spaceId, id);
    if (!entry) throw experienceMissing();
    const option = quickOptions.parse(entry.question.options).find((item) => item.id === optionId);
    if (!option)
      throw new ServiceError('invalid_choice', 'Choose one of the offered answers.', 400);
    if (!this.questions) return unavailable('Answers are not connected yet.');
    if (entry.question.source === 'memory')
      return unavailable('Open this memory item to choose the detail to keep.');
    const result = await this.questions.answer(id, { text: option.label });
    if (result.error)
      throw new ServiceError(
        'answer_not_accepted',
        'This answer could not be accepted. Try again.',
        409,
      );
    return { status: 'ok' };
  }
}
