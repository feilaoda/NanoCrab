export type Role = "user" | "assistant";

export type InboundMessage = {
  chatId: string;
  senderId: string;
  senderName?: string;
  isGroup: boolean;
  isMentioned: boolean;
  text: string;
  timestamp: string;
  rawEvent: unknown;
};

export type AgentRequest = {
  conversationId: string;
  userText: string;
  modelOverride?: string;
  backendOverride?: "cli" | "sdk";
  contextMessages: Array<{ role: Role; content: string }>;
};

export type AgentResponse =
  | {
      type: "message";
      text: string;
    }
  | {
      type: "needs_approval";
      text: string;
      approvalId: string;
      summary: string;
    };

export type ApprovalRecord = {
  id: string;
  conversationId: string;
  status: "pending" | "approved" | "rejected";
  payload: string;
  createdAt: string;
  updatedAt: string;
};
