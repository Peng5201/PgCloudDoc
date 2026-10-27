import { useEffect, useState } from "react";
import { SheetView } from "./app/spreadsheet/SheetView";
import type { IWorkbookData } from "./app/spreadsheet/engine";

function App() {
  const [snapshot, setSnapshot] = useState<Partial<IWorkbookData> | null>(null);

  useEffect(() => {
    fetch('/api/testSheet')
      .then((res) => res.json())
      .then((data) => setSnapshot(data))
      .catch((err) => console.error('加载表格数据失败:', err));
  }, []);

  if (!snapshot) {
    return <div className="app">加载中...</div>;
  }

  return (
    <div className="app">
      <SheetView snapshot={snapshot} />
    </div>
  );
}

export default App;
