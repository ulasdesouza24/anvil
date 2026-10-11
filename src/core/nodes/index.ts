import { Registry } from "../registry.js";
import { AgentNode, LlmNode, LlmStructuredNode, RefineNode } from "./ai.js";
import { CodeAgentNode } from "./codeAgent.js";
import { DecisionNode } from "./decision.js";
import { HumanApprovalNode, HumanInputNode } from "./human.js";
import { InputNode, OutputNode } from "./io.js";
import { CodeNode, MapNode, MergeNode, RouterNode, SubagentNode, TransformNode } from "./logic.js";
import { BrowserNode, FileNode, HttpNode, KnowledgeSearchNode, MemoryNode, WebFetchNode, WebSearchNode } from "./tools.js";
import { SEND_NODE_CLASSES } from "./send.js";
import { ActionGateNode } from "./gate.js";

export const CORE_NODE_CLASSES = [
  InputNode,
  OutputNode,
  LlmNode,
  LlmStructuredNode,
  AgentNode,
  RefineNode,
  DecisionNode,
  RouterNode,
  MergeNode,
  MapNode,
  SubagentNode,
  TransformNode,
  CodeNode,
  CodeAgentNode,
  HttpNode,
  WebFetchNode,
  WebSearchNode,
  BrowserNode,
  KnowledgeSearchNode,
  MemoryNode,
  FileNode,
  HumanApprovalNode,
  HumanInputNode,
  ActionGateNode,
  ...SEND_NODE_CLASSES,
];

export function createCoreRegistry(): Registry {
  return new Registry().register(...CORE_NODE_CLASSES);
}
