/*
 * app.js —— 启动入口：静态配置（乐器/口令/音高、总步数），组装规则、存储与交互三层。
 * 业务规则见 rules.js，持久化见 store.js，DOM 交互见 ui.js。
 */
(function (global) {
  "use strict";

  const instruments = [
    { name: "大锣", token: "仓", freq: 180 },
    { name: "鼓", token: "冬", freq: 120 },
    { name: "钹", token: "才", freq: 360 },
    { name: "小锣", token: "台", freq: 520 }
  ];
  const steps = 16;

  const store = global.LuoguStore.createStore(instruments);
  global.LuoguUI.initUI({ store, instruments, steps });
})(window);
