'use strict';
const {NativeNotifier} = require('../ui/lib/broker');
(async () => {
  const notifier = new NativeNotifier();
  try {
    await notifier.deliver({title: 'Codex 扩展通知测试', body: '本机通知组件已就绪。\n这是扩展安装前的一次弹窗和声音测试。', desktop: true, sound: true});
    console.log('Windows acknowledged the native notification request.');
    await new Promise(resolve => setTimeout(resolve, 6000));
  } finally { notifier.close(); }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
