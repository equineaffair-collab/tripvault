/**
 * F2 — expiry reminder logic.
 *
 * Pure, so the daily sweep's decisions can be tested without a database or a
 * clock. The Edge Function supplies the rows and the date; everything about
 * *which* reminders are owed and *how* they should be delivered is decided here.
 */
import { addMonths, daysBetween } from './dates.ts';

/** Months before expiry at which F2 reminds. Ordered most to least distant. */
export const MILESTONES = [6, 3, 1] as const;
export type Milestone = (typeof MILESTONES)[number];

export type ReminderChannel = 'email' | 'push' | 'banner';

/**
 * F2 escalates the channel with urgency rather than firing the same one three
 * times: email at six months, email + push at three, and at one month a
 * persistent in-app banner as well.
 */
export function channelsForMilestone(milestone: Milestone): ReminderChannel[] {
  switch (milestone) {
    case 6:
      return ['email'];
    case 3:
      return ['email', 'push'];
    case 1:
      return ['email', 'push', 'banner'];
  }
}

/**
 * Email is deliberately not user-disableable, even though push is.
 *
 * F2's reasoning: silencing both would mean the app's core promise — that you
 * won't be caught out by an expired document — quietly stops holding, with no
 * signal that it has. Email is also the durable channel: it survives a phone
 * change and does not depend on notification permissions.
 */
export function canUserDisable(channel: ReminderChannel): boolean {
  return channel !== 'email';
}

/** Channels actually used for a milestone, given this user's preferences. */
export function effectiveChannels(
  milestone: Milestone,
  prefs: { pushEnabled: boolean }
): ReminderChannel[] {
  return channelsForMilestone(milestone).filter((c) => {
    if (!canUserDisable(c)) return true;
    if (c === 'push') return prefs.pushEnabled;
    return true;
  });
}

/** The date a milestone becomes due for a document expiring on `expiryDate`. */
export function triggerDate(expiryDate: string, milestone: Milestone): string {
  return addMonths(expiryDate, -milestone);
}

export type ReminderPlan = {
  /** The single milestone to act on today, or null if none is owed. */
  send: Milestone | null;
  /**
   * Milestones whose moment has passed but which are superseded by `send`.
   * Recorded as already handled so they never fire late.
   */
  supersede: Milestone[];
  /** True once the document is past its expiry date. */
  expired: boolean;
};

/**
 * Decide what a single document is owed today.
 *
 * The important behaviour is what happens when several milestones are due at
 * once — which is the normal case whenever someone adds a passport that already
 * expires soon. Firing six-month, three-month and one-month notices in the same
 * sweep would be three emails saying increasingly urgent versions of the same
 * thing. So only the most urgent is sent, and the ones it overtook are recorded
 * as handled rather than left to fire on later days.
 */
export function planReminder(args: {
  expiryDate: string | null;
  today: string;
  /** Milestones already sent or superseded for this document. */
  handled: readonly number[];
}): ReminderPlan {
  const { expiryDate, today, handled } = args;
  if (!expiryDate) return { send: null, supersede: [], expired: false };

  const expired = daysBetween(today, expiryDate) < 0;

  // Due = the trigger date has arrived, and we have not dealt with it before.
  const due = MILESTONES.filter(
    (m) => !handled.includes(m) && daysBetween(triggerDate(expiryDate, m), today) >= 0
  );

  if (due.length === 0) return { send: null, supersede: [], expired };

  // MILESTONES runs 6, 3, 1 — most distant first — so the most urgent due
  // milestone is the last one in the list.
  const send = due[due.length - 1];
  const supersede = due.filter((m) => m !== send);

  return { send, supersede, expired };
}

export type DocumentRow = {
  id: string;
  traveler_id: string;
  type: string;
  expiry_date: string | null;
  country: string | null;
};

export type PlannedReminder = {
  documentId: string;
  travelerId: string;
  milestone: Milestone;
  channels: ReminderChannel[];
  expiryDate: string;
  expired: boolean;
  supersede: Milestone[];
};

/**
 * Plan a whole sweep. Given every document and what has already been handled,
 * return the reminders to create today.
 */
export function planSweep(args: {
  documents: readonly DocumentRow[];
  handledByDocument: Readonly<Record<string, number[]>>;
  today: string;
  prefsByTraveler?: Readonly<Record<string, { pushEnabled: boolean }>>;
}): PlannedReminder[] {
  const { documents, handledByDocument, today } = args;
  const out: PlannedReminder[] = [];

  for (const doc of documents) {
    const plan = planReminder({
      expiryDate: doc.expiry_date,
      today,
      handled: handledByDocument[doc.id] ?? [],
    });
    if (plan.send === null) continue;

    const prefs = args.prefsByTraveler?.[doc.traveler_id] ?? { pushEnabled: true };

    out.push({
      documentId: doc.id,
      travelerId: doc.traveler_id,
      milestone: plan.send,
      channels: effectiveChannels(plan.send, prefs),
      expiryDate: doc.expiry_date as string,
      expired: plan.expired,
      supersede: plan.supersede,
    });
  }

  return out;
}

/** Human wording for a reminder, shared by email, push and the in-app banner. */
export function reminderText(args: {
  travelerName: string;
  documentType: string;
  expiryDate: string;
  milestone: Milestone;
  expired: boolean;
}): { subject: string; body: string } {
  const noun = args.documentType === 'passport' ? 'passport' : args.documentType.replace('_', ' ');

  if (args.expired) {
    return {
      subject: `${args.travelerName}'s ${noun} has expired`,
      body: `${args.travelerName}'s ${noun} expired on ${args.expiryDate}. You'll need to renew it before travelling.`,
    };
  }

  const window =
    args.milestone === 1 ? 'in under a month' : `in about ${args.milestone} months`;

  return {
    subject: `${args.travelerName}'s ${noun} expires ${window}`,
    body:
      `${args.travelerName}'s ${noun} expires on ${args.expiryDate}. ` +
      (args.milestone === 1
        ? 'Renewals can take several weeks, so this is worth starting now.'
        : 'Many countries also ask for six months of validity beyond your stay, so it may already be too close for some trips.'),
  };
}
