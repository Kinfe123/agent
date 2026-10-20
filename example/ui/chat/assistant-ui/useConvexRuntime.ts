import {
  MessageNotSentError,
  useExternalStoreRuntime,
} from "@assistant-ui/react";
import {
  optimisticallySendMessage,
  useUIMessages,
} from "@convex-dev/agent/react";
import { useMutation } from "convex/react";
import { useRef } from "react";
import { api } from "../../../convex/_generated/api";
import { convertMessage, pendingApprovalIds } from "./convertMessage";

export function useConvexRuntime(threadId: string) {
  const { results, status, loadMore } = useUIMessages(
    api.chat.approval.listThreadMessages,
    { threadId },
    { initialNumItems: 10, stream: true },
  );
  const sendMessage = useMutation(
    api.chat.approval.sendMessage,
  ).withOptimisticUpdate(
    optimisticallySendMessage(api.chat.approval.listThreadMessages),
  );
  const submitApproval = useMutation(api.chat.approval.submitApproval);
  const triggerContinuation = useMutation(
    api.chat.approval.triggerContinuation,
  );
  const abortStream = useMutation(api.chat.streamAbort.abortStreamByOrder);
  const answeredApprovals = useRef(new Set<string>());
  const latest = results.findLast((message) => message.role === "assistant");
  const pendingApprovals = pendingApprovalIds(latest);

  return useExternalStoreRuntime({
    messages: results,
    convertMessage,
    isLoading: status === "LoadingFirstPage",
    isDisabled: status === "LoadingFirstPage",
    isSendDisabled: pendingApprovals.length > 0,
    isRunning: latest?.status === "pending" || latest?.status === "streaming",
    hasEarlier: status === "CanLoadMore",
    onLoadEarlier: async () => loadMore(10),
    onNew: async ({ content: [part, ...rest] }) => {
      if (part?.type !== "text" || rest.length) {
        throw new MessageNotSentError("This example accepts text only.");
      }
      try {
        await sendMessage({ threadId, prompt: part.text });
      } catch (cause) {
        throw new MessageNotSentError(String(cause));
      }
    },
    onRespondToToolApproval: async ({ approvalId, approved, reason }) => {
      const { messageId } = await submitApproval({
        threadId,
        approvalId,
        approved,
        reason,
      });
      // Approvals in a step are answered one at a time; generation continues
      // from the last response, once every request in the step has one.
      answeredApprovals.current.add(approvalId);
      if (pendingApprovals.every((id) => answeredApprovals.current.has(id))) {
        await triggerContinuation({
          threadId,
          lastApprovalMessageId: messageId,
        });
      }
    },
    ...(latest?.status === "streaming"
      ? {
          onCancel: async () => {
            await abortStream({ threadId, order: latest.order });
          },
        }
      : {}),
  });
}
