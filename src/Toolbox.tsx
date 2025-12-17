import { store, useStore } from "./store/index.ts";
import { Tool } from "./types.ts";
import styles from "./Toolbox.module.css";

const tools: { id: Tool; icon: string; title: string }[] = [
  { id: "select", icon: "\u{1F5B1}", title: "Select (V)" },
  { id: "line", icon: "\u{1F4CF}", title: "Line (P)" },
];

export const Toolbox = () => {
  const currentTool = useStore((s) => s.tool);

  return (
    <div className={styles.toolbox}>
      {tools.map((tool) => (
        <button
          key={tool.id}
          className={`${styles.tool} ${currentTool === tool.id ? styles.active : ""}`}
          onClick={() => store.setTool(tool.id)}
          title={tool.title}
        >
          {tool.icon}
        </button>
      ))}
    </div>
  );
};
