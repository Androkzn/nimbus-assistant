import type { AnswerState } from "./answer";

export interface StoredTurn {
  id: string;
  question: string;
  answer: AnswerState;
}

export interface ConversationSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}

export interface StoredConversation extends ConversationSummary {
  turns: StoredTurn[];
}
