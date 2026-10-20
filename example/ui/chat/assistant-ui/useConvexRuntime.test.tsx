// @vitest-environment jsdom
import {
  AssistantRuntimeProvider,
  ComposerPrimitive,
} from "@assistant-ui/react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import type { UIMessage } from "@convex-dev/agent/react";
import type { OptimisticLocalStore, PaginationStatus } from "convex/browser";
import { getFunctionName } from "convex/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../../convex/_generated/api";
import { Thread } from "./Thread";
import { useConvexRuntime } from "./useConvexRuntime";

const mocks = vi.hoisted(() => ({
  messages: [] as UIMessage[],
  status: "Exhausted" as PaginationStatus,
  loadMore: vi.fn(),
  mutations: new Map<string, ReturnType<typeof vi.fn>>(),
  optimisticUpdates: new Map<string, unknown>(),
}));

vi.mock("@convex-dev/agent/react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@convex-dev/agent/react")>()),
  useUIMessages: () => ({
    results: mocks.messages,
    status: mocks.status,
    loadMore: mocks.loadMore,
  }),
}));
vi.mock("convex/react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("convex/react")>()),
  useMutation: (ref: Parameters<typeof getFunctionName>[0]) => {
    const name = getFunctionName(ref);
    const mutation = mocks.mutations.get(name)!;
    return Object.assign(mutation, {
      withOptimisticUpdate: (update: unknown) => {
        mocks.optimisticUpdates.set(name, update);
        return mutation;
      },
    });
  },
}));

const mutation = (ref: Parameters<typeof getFunctionName>[0]) =>
  mocks.mutations.get(getFunctionName(ref))!;
const sendMessage = () => mutation(api.chat.approval.sendMessage);
const submitApproval = () => mutation(api.chat.approval.submitApproval);
const abortStream = () => mutation(api.chat.streamAbort.abortStreamByOrder);

const assistant = (overrides: Partial<UIMessage> = {}): UIMessage => ({
  id: "stream-id",
  key: "thread-1-1-0",
  role: "assistant",
  parts: [{ type: "text", text: "Done." }],
  text: "Done.",
  status: "success",
  order: 1,
  stepOrder: 0,
  _creationTime: 1_700_000_000_000,
  ...overrides,
});

const awaitingApprovals = assistant({
  parts: [
    {
      type: "tool-deleteFile",
      toolCallId: "call-1",
      state: "approval-requested",
      input: { filename: "important.txt" },
      approval: { id: "approval-1" },
    },
    {
      type: "tool-transferMoney",
      toolCallId: "call-2",
      state: "approval-requested",
      input: { amount: 500, toAccount: "savings-123" },
      approval: { id: "approval-2" },
    },
  ],
  text: "",
});

const toolPart = (
  result: { current: ReturnType<typeof useConvexRuntime> },
  toolCallId: string,
) =>
  result.current.thread
    .getMessageByIndex(0)
    .getMessagePartByToolCallId(toolCallId);

beforeEach(() => {
  mocks.messages = [];
  mocks.status = "Exhausted";
  mocks.loadMore.mockReset();
  mocks.optimisticUpdates.clear();
  for (const ref of [
    api.chat.approval.sendMessage,
    api.chat.approval.submitApproval,
    api.chat.streamAbort.abortStreamByOrder,
  ]) {
    mocks.mutations.set(getFunctionName(ref), vi.fn());
  }
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("useConvexRuntime", () => {
  it("sends through the scheduling mutation with an optimistic user message", async () => {
    sendMessage().mockResolvedValue({ messageId: "m-1" });
    const { result } = renderHook(() => useConvexRuntime("thread-1"));
    await act(() => result.current.thread.append("Delete important.txt"));
    expect(sendMessage()).toHaveBeenCalledWith({
      threadId: "thread-1",
      prompt: "Delete important.txt",
    });

    const query = api.chat.approval.listThreadMessages;
    const args = {
      threadId: "thread-1",
      paginationOpts: { numItems: 10, cursor: null },
    };
    const setQuery = vi.fn();
    const store = {
      getAllQueries: () => [
        { args, value: { page: [], isDone: true, continueCursor: "" } },
      ],
      setQuery,
    } as unknown as OptimisticLocalStore;
    const update = mocks.optimisticUpdates.get(
      getFunctionName(api.chat.approval.sendMessage),
    ) as (
      store: OptimisticLocalStore,
      args: { threadId: string; prompt: string },
    ) => void;
    update(store, { threadId: "thread-1", prompt: "Delete important.txt" });
    expect(setQuery).toHaveBeenCalledWith(query, args, {
      page: [
        expect.objectContaining({
          role: "user",
          status: "pending",
          text: "Delete important.txt",
        }),
      ],
      isDone: true,
      continueCursor: "",
    });
  });

  it("returns an unsent prompt to the composer", async () => {
    sendMessage().mockRejectedValue(new Error("Offline"));
    const { result } = renderHook(() => useConvexRuntime("thread-1"));
    const composer = result.current.thread.composer;
    act(() => composer.setText("Keep this prompt"));
    await act(() => composer.send());
    await waitFor(() =>
      expect(composer.getState().text).toBe("Keep this prompt"),
    );
  });

  it("is running only while the latest assistant message is pending or streaming", () => {
    const stale = assistant({ key: "thread-1-1-0", status: "streaming" });
    const user: UIMessage = {
      ...assistant(),
      key: "thread-1-2-0",
      role: "user",
      order: 2,
    };
    mocks.messages = [stale, assistant({ key: "thread-1-1-1", stepOrder: 1 })];
    const { result, rerender } = renderHook(() => useConvexRuntime("thread-1"));
    expect(result.current.thread.getState().isRunning).toBe(false);

    mocks.messages = [...mocks.messages, user];
    rerender();
    expect(result.current.thread.getState().isRunning).toBe(false);

    mocks.messages = [
      ...mocks.messages,
      assistant({ key: "thread-1-2-1", order: 2, status: "pending" }),
    ];
    rerender();
    expect(result.current.thread.getState().isRunning).toBe(true);
  });

  it("blocks sending while the latest step awaits approval", () => {
    mocks.messages = [awaitingApprovals];
    const { result, rerender } = renderHook(() => useConvexRuntime("thread-1"));
    const composer = result.current.thread.composer;
    act(() => composer.setText("Never mind"));
    expect(composer.getState().canSend).toBe(false);
    mocks.messages = [assistant()];
    rerender();
    expect(composer.getState().canSend).toBe(true);
  });

  it("submits each approval decision", async () => {
    mocks.messages = [awaitingApprovals];
    submitApproval()
      .mockResolvedValueOnce({ messageId: "response-1" })
      .mockResolvedValueOnce({ messageId: "response-2" });
    const { result } = renderHook(() => useConvexRuntime("thread-1"));

    await act(() =>
      toolPart(result, "call-1").respondToToolApproval({ approved: true }),
    );
    expect(submitApproval()).toHaveBeenLastCalledWith({
      threadId: "thread-1",
      approvalId: "approval-1",
      approved: true,
    });

    await act(() =>
      toolPart(result, "call-2").respondToToolApproval({
        approved: false,
        reason: "Too much",
      }),
    );
    expect(submitApproval()).toHaveBeenLastCalledWith({
      threadId: "thread-1",
      approvalId: "approval-2",
      approved: false,
      reason: "Too much",
    });
  });

  it("renders approval controls on each gated tool call", async () => {
    mocks.messages = [awaitingApprovals];
    submitApproval().mockResolvedValue({ messageId: "response-1" });
    // jsdom lacks the layout APIs the thread viewport uses.
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    Element.prototype.scrollTo = () => {};
    const { result, rerender } = renderHook(() => useConvexRuntime("thread-1"));
    render(
      <AssistantRuntimeProvider runtime={result.current}>
        <Thread />
      </AssistantRuntimeProvider>,
    );
    expect(screen.getByText("deleteFile · Needs approval")).toBeDefined();
    expect(screen.getByText("transferMoney · Needs approval")).toBeDefined();
    fireEvent.click(screen.getAllByRole("button", { name: "Deny" })[1]);
    await waitFor(() =>
      expect(submitApproval()).toHaveBeenCalledWith({
        threadId: "thread-1",
        approvalId: "approval-2",
        approved: false,
      }),
    );

    const [deleteFile, transferMoney] = awaitingApprovals.parts;
    mocks.messages = [
      {
        ...awaitingApprovals,
        parts: [
          {
            ...deleteFile,
            state: "approval-responded",
            approval: { id: "approval-1", approved: true },
          } as UIMessage["parts"][number],
          transferMoney,
        ],
      },
    ];
    act(() => rerender());
    expect(screen.getByText("deleteFile · Approved")).toBeDefined();
    expect(screen.getByText("transferMoney · Needs approval")).toBeDefined();
    expect(screen.getAllByRole("button", { name: "Approve" })).toHaveLength(1);
  });

  it("surfaces an approval that fails to save", async () => {
    mocks.messages = [
      assistant({ parts: awaitingApprovals.parts.slice(0, 1) }),
    ];
    submitApproval().mockRejectedValueOnce(new Error("Not allowed"));
    const { result } = renderHook(() => useConvexRuntime("thread-1"));
    await expect(
      toolPart(result, "call-1").respondToToolApproval({ approved: true }),
    ).rejects.toThrow("Not allowed");
  });

  it("enables Stop once the latest assistant message streams, and aborts it by order", () => {
    mocks.messages = [assistant({ status: "pending" })];
    const { result, rerender } = renderHook(() => useConvexRuntime("thread-1"));
    render(
      <AssistantRuntimeProvider runtime={result.current}>
        <ComposerPrimitive.Cancel>Stop response</ComposerPrimitive.Cancel>
      </AssistantRuntimeProvider>,
    );
    const stop = screen.getByRole("button", {
      name: "Stop response",
    }) as HTMLButtonElement;
    expect(stop.disabled).toBe(true);

    mocks.messages = [assistant({ status: "streaming", order: 3 })];
    rerender();
    expect(stop.disabled).toBe(false);
    fireEvent.click(stop);
    expect(abortStream()).toHaveBeenCalledWith({
      threadId: "thread-1",
      order: 3,
    });

    mocks.messages = [assistant({ status: "failed", order: 3 })];
    rerender();
    expect(stop.disabled).toBe(true);
  });

  it("keeps a streamed message's identity when it is persisted", () => {
    mocks.messages = [assistant({ status: "streaming" })];
    const { result, rerender } = renderHook(() => useConvexRuntime("thread-1"));
    mocks.messages = [assistant({ id: "saved-id" })];
    rerender();
    const state = result.current.thread.getState();
    expect(state.isRunning).toBe(false);
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0].id).toBe("thread-1-1-0");
  });

  it("loads earlier messages through the runtime while the first page is ready", async () => {
    mocks.status = "LoadingFirstPage";
    const { result, rerender } = renderHook(() => useConvexRuntime("thread-1"));
    expect(result.current.thread.getState()).toMatchObject({
      isLoading: true,
      isDisabled: true,
      isRunning: false,
      hasEarlier: false,
    });
    mocks.status = "CanLoadMore";
    rerender();
    expect(result.current.thread.getState()).toMatchObject({
      isLoading: false,
      isDisabled: false,
      hasEarlier: true,
    });
    await act(() => result.current.thread.loadEarlier());
    expect(mocks.loadMore).toHaveBeenCalledWith(10);
  });
});
