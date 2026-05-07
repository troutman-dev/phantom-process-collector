import type { LineageNode } from "../types";

interface Props {
  node: LineageNode;
  depth?: number;
}

function nodeColor(phantomIndex: number): string {
  if (phantomIndex >= 70) return "#ef4444";
  if (phantomIndex >= 40) return "#f59e0b";
  return "#22c55e";
}

export default function LineageMap({ node, depth = 0 }: Props) {
  const color = nodeColor(node.phantomIndex);
  return (
    <div className={`${depth > 0 ? "ml-6 border-l-2 border-gray-200 pl-3 mt-1" : ""}`}>
      <div
        className="flex items-center gap-2 py-1 px-2 rounded-md hover:bg-gray-50 transition-colors"
        style={{ borderLeft: depth === 0 ? `3px solid ${color}` : undefined }}
      >
        <div
          className="w-2.5 h-2.5 rounded-full flex-shrink-0"
          style={{ backgroundColor: color }}
        />
        <span className="font-medium text-sm text-gray-900">{node.name}</span>
        <span className="text-xs text-gray-400 font-mono">({node.pid})</span>
        <span
          className="ml-auto text-xs font-bold font-mono"
          style={{ color }}
        >
          {node.phantomIndex.toFixed(1)}
        </span>
      </div>
      {node.children.map((child) => (
        <LineageMap key={child.pid} node={child} depth={depth + 1} />
      ))}
    </div>
  );
}
