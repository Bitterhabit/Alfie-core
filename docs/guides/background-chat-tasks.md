# Background chat tasks

## When to use it

Use the **Run in background** checkbox in the chat composer for work that may take several minutes or where you may close the browser before Alfie finishes. Ordinary chat continues to use the live streaming path.

## Start and follow a task

1. Open the conversation you want the result saved into.
2. Enable **Run in background** beside the chat mode controls.
3. Send the request. Alfie saves the user turn and returns a task ID immediately.
4. The chat shows progress while the page is open. You can leave the page or close the browser; the Core worker continues independently.
5. Reopen the same conversation to see whether the task is queued, running, waiting for approval, completed, failed, or interrupted.
6. The assistant result is saved into the original conversation when execution completes.

## Approval and cancellation

- If a task proposes a write or external action, it pauses for the existing explicit approval flow. Alfie cannot approve its own action.
- Review pending actions under **Tools & access**.
- Background tasks also appear in the workshop/job list under **Tools & access**. Use **Cancel** to stop a queued/running task or reject its pending approval.

## Limits and recovery

- Agent execution and provider requests have a 30-minute ceiling. The chat client transport allows 35 minutes; background task submission itself returns immediately.
- Closing the browser does not cancel a running task.
- If Alfie Core restarts while a task is running, the task is marked **interrupted** rather than automatically replayed. This avoids repeating a tool side effect. Queued tasks are picked up when you next open a conversation or the jobs list.
- The worker currently runs in one Core process. It does not yet resume an in-flight model turn from a checkpoint after a Core restart.

## Privacy

Task inputs are stored in the same per-user protected storage boundary as Alfie conversations. Job-list API responses omit the private task payload; only the owning user can retrieve that user’s job records.