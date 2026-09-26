export interface WorkflowNamespace {
  readonly id: string;
  readonly projectKey: string;
  readonly cwd: string;
  readonly storageRoot?: string;
}

export interface WorkflowLease {
  readonly active: boolean;
  release(): Promise<void>;
}

export interface WorkflowLeaseProvider {
  acquire(namespace: Readonly<WorkflowNamespace>): Promise<WorkflowLease>;
  isHeld(namespace: Readonly<WorkflowNamespace>): Promise<boolean>;
}
