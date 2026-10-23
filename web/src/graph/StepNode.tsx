/* Custom execution node. Every field it shows is a real StepView fact: state
   (drives both the tone and the leading glyph), attempt count, live lease claim,
   and compensability. No duration is printed on the node itself — per-step
   durations are not exposed on StepView (only on attempts), so the node defers
   that to the detail rail. Colour never travels alone: the badge text co-renders. */
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";

import { stepStatus, type StatusTone } from "../theme/status";
import { StatusBadge } from "../components/ui";
import {
  IconAlert,
  IconCheck,
  IconClock,
  IconLease,
  IconSpinner,
  IconUndo,
  IconX,
} from "../icons";
import { NODE_H, NODE_W, type StepNodeData } from "./layout";
import "./graph.css";

type StepFlowNode = Node<StepNodeData>;

function statusGlyph(tone: StatusTone) {
  switch (tone) {
    case "completed":
      return <IconCheck size={13} />;
    case "running":
      return <IconSpinner size={13} className="spin" />;
    case "compensating":
      return <IconUndo size={13} />;
    case "negative":
      return <IconX size={13} />;
    case "manual":
    case "warn":
      return <IconAlert size={13} />;
    default:
      return <IconClock size={13} />;
  }
}

export function StepNode({ data }: NodeProps<StepFlowNode>) {
  const { step, index, selected } = data;
  const meta = stepStatus(step.state);
  const running = step.state === "ISSUED" || step.state === "IN_PROGRESS";
  const compensating = step.state.startsWith("COMPENSAT");
  return (
    <div
      className={`fx-node fx-node--${meta.tone} ${selected ? "fx-node--selected" : ""}`}
      style={{ width: NODE_W, height: NODE_H }}
      data-step={step.step_type}
    >
      {index > 0 && <Handle type="target" position={Position.Left} className="fx-node__handle" />}
      <Handle type="source" position={Position.Right} className="fx-node__handle" />

      <div className="fx-node__top">
        <span className={`fx-node__icon fx-node__icon--${meta.tone}`} aria-hidden="true">
          {statusGlyph(meta.tone)}
        </span>
        <span className="fx-node__type mono" title={step.step_type}>{step.step_type}</span>
        {step.compensable && (
          <span className="fx-node__comp" title={step.compensator_task ? `compensates via ${step.compensator_task}` : "compensable"}>
            <IconUndo size={12} />
          </span>
        )}
      </div>

      <div className="fx-node__foot">
        <StatusBadge state={step.state} kind="step" size="sm" />
        <span className="fx-node__attempts num" title="active attempt / max attempts">
          {step.active_attempt}/{step.max_attempts}
        </span>
        {running && step.lease_holder && (
          <span className="fx-node__lease fx-node__lease--live" title={`lease held by ${step.lease_holder}`}>
            <IconLease size={11} />
          </span>
        )}
        {compensating && <span className="fx-node__rollback">rolling back</span>}
      </div>
    </div>
  );
}
