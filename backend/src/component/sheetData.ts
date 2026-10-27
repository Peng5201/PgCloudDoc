export const testSheetData = {
  "id": "wb-001",                    // 工作簿唯一 id
  "name": "销售报表",
  "appVersion": "3.0.0",             // snapshot 格式版本，务必填
  "locale": "zhCN",

  "styles": {                        // 样式表：单元格按 id 引用，勿内联
    "s1": { "bl": 1, "fs": 12, "bg": { "rgb": "#EEF2FF" } },
    "s2": { "ff": "Arial", "cl": { "rgb": "#DC2626" } },
    "s3": { "bd": { "t": { "s": 1, "cl": { "rgb": "#000" } } } }
  },

  "sheetOrder": ["core", "detail"],   // sheet 顺序

  "sheets": {
    "core": {
      "id": "core",
      "name": "汇总",
      "rowCount": 40,
      "columnCount": 18,
      "zoomRatio": 1,
      "defaultRowHeight": 24,
      "defaultColumnWidth": 88,
      "showGridlines": 1,
      "freeze": { "startRow": 1, "startColumn": 0, "ySplit": 1, "xSplit": 0 },

      "cellData": {                  // 稀疏矩阵：{ [行]: { [列]: ICellData } }
        "0": {
          "0": { "v": "商品",  "t": 1, "s": "s1" },
          "1": { "v": "金额",  "t": 1, "s": "s1" },
          "2": { "v": "合计",  "t": 1, "s": "s1" }
        },
        "1": {
          "0": { "v": "笔记本", "t": 1 },
          "1": { "v": 1280.5,   "t": 2 },
          "2": { "f": "=SUM(B2:B2)", "v": 1280.5, "t": 2 }   // f=公式, v=缓存结果
        },
        "2": {
          "0": { "v": "键盘", "t": 1 },
          "1": { "v": 460,    "t": 2 },
          "2": { "f": "=SUM(B2:B3)", "v": 1740.5, "t": 2 }
        }
      },

      "rowData": { "0": { "h": 32 } },          // 稀疏：只写自定义行高
      "columnData": { "0": { "w": 120 }, "1": { "w": 100 } },

      "mergeData": [ { "startRow": 3, "startColumn": 0, "endRow": 3, "endColumn": 2 } ]
    },

    "detail": {
      "id": "detail",
      "name": "明细",
      "rowCount": 20,
      "columnCount": 8,
      "cellData": {},
      "rowData": {},
      "columnData": {},
      "mergeData": []
    }
  },

  "resources": []     // 插件数据（筛选/批注/条件格式），没用插件就留空数组
}
