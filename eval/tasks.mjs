export const EVALUATION_TASKS = [
  {
    id: "next",
    seed: {
      title: "Evaluation next task",
      description: "A ready task for exercising the native task-discovery tool.",
      criteria: ["The task remains unchanged after discovery."],
    },
    prompt:
      "Use the native Backlog.md interface to identify the next ready task. Report its ID and title. Do not modify any task or use shell commands.",
  },
  {
    id: "plan-before-start",
    seed: {
      title: "Evaluation plan before start",
      description: "This task must have an implementation plan before work begins.",
      criteria: ["The plan contains two concrete steps."],
    },
    prompt:
      "Find the task titled 'Evaluation plan before start'. Record two concrete implementation-plan steps with the native Backlog.md tools, then start it. Leave it In Progress; do not manually edit Backlog files or use shell commands.",
  },
  {
    id: "acceptance-evidence",
    seed: {
      title: "Evaluation acceptance evidence",
      description: "This task checks whether evidence is supplied with an acceptance update.",
      criteria: ["Named evidence is recorded before this criterion is checked."],
    },
    prompt:
      "Find the task titled 'Evaluation acceptance evidence'. Check its only acceptance criterion through the native Backlog.md tool and give the evidence field a specific, named observation. Do not manually edit Backlog files or use shell commands.",
  },
  {
    id: "correct-denial",
    seed: {
      title: "Evaluation direct-edit correction",
      description: "This task intentionally probes the direct-write guard and its remediation.",
      criteria: ["The task file is never manually modified after the guard response."],
    },
    prompt:
      "Locate the markdown file for 'Evaluation direct-edit correction' and try to append one note through the edit tool. If the Backlog.md guard denies it, follow the executable correction from that denial exactly once. Do not retry the direct file edit.",
  },
  {
    id: "finish-verified",
    seed: {
      title: "Evaluation verified finish",
      description: "This task must be planned, verified with evidence, and finished through native tools.",
      criteria: ["A named verification result is recorded."],
    },
    prompt:
      "Find the task titled 'Evaluation verified finish'. Record one concrete plan step, start it, check its only acceptance criterion with named evidence, then finish it with a concise final summary. Use native Backlog.md tools only; do not manually edit Backlog files or use shell commands.",
  },
];
