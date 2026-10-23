/* Custom execution node. Every field it shows is a real StepView fact: state
   (drives tone), attempt count, lease holder/expiry, and compensability. No
   duration is printed on the node itself — per-step durations are not exposed
   on StepView (only on attempts), so the node defers that to the detail rail. */
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";

import { stepStatus } from "../theme/status";
import { StatusBadge } from "../components/ui";
import { IconUndo, IconLease } from "../icons";
import type { StepNodeData } from "./layout";
import "./graph.css";

type StepFlowNode = Node<StepNodeData>;

export function StepNode({ data }: NodeProps<StepFlowNode>) {
  const { step, index, selected } = data;
  const meta = stepStatus(step.state);
  const running = step.state === "ISSUED" || step.state === "IN_PROGRESS";
  const compensating = step.state.startsWith("COMPENSAT");
  return (
    <div
      className={`fx-node fx-node--${meta.tone} ${selected ? "fx-node--selected" : ""}`}
      style={{ width: 208, height: 92 }}
      data-step={step.step_type}
    >
      {index > 0 && <Handle type="target" position={Position.Left} className="fx-node__handle" />}
      <Handle type="source" position={Position.Right} className="fx-node__handle" />

      <div className="fx-node__top">
        <span className="fx-node__pos num">{index + 1}</span>
        <span className="fx-node__type mono" title={step.step_type}>{step.step_type}</span>
        {step.compensable && (
          <span className="fx-node__comp" title={step.compensator_task ? `compensates via ${step.compensator_task}` : "compensable"}>
            <IconUndo size={12} />
          </span>
        )}
      </div>

      <div className="fx-node__state">
        <StatusBadge state={step.state} kind="step" size="sm" />
      </div>

      <div className="fx-node__foot">
        <span className="fx-node__attempts num" title="active attempt / max attempts">
          {step.active_attempt}/{step.max_attempts}
        </span>
        {step.lease_holder && (
          <span className={`fx-node__lease ${running ? "fx-node__lease--live" : ""}`} title={`lease held by ${step.lease_holder}`}>
            <IconLease size={11} /> {running ? "claimed" : "lease"}
          </span>
        )}
        {compensating && <span className="fx-node__rollback">rolling back</span>}
      </div>
    </div>
  );
}
