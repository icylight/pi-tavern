/**
 * 群聊环境注入文案单一来源（B2 消费端域集中化）。
 *
 * C 类红线（shared/messages.ts 头注释， 定案）：环境注入模板格式串
 * 留消费端、不进 shared/messages.ts——注入格式串与消费端渲染/测试断言
 * 强耦合，留消费端防全局域膨胀与误用。本文件即 C 类在 character 消费端
 * 的集中落点（方案 b）。
 *
 * 引用契约：identity-consistency.test.ts:195-208 与
 * group-chat-input.test.ts:179 断言引用以下字面值——改文案必须同步测试。
 */

/** 注入头部标题（buildContent 每批首行）。 */
export const INJECTION_HEADER_TITLE = "PiTavern 群聊环境更新";

/** 身份锚前缀（三字段契约；动态部分 = 名字/character_id 拼接）。 */
export const INJECTION_IDENTITY_PREFIX = "你的当前角色：";

/** 群聊来源声明（S2 契约文案，全角冒号；与身份行同批注入）。 */
export const INJECTION_SOURCE_GROUP = "来源：群聊";

/** 验收观察通道前缀（PITAVERTEST=1 notify，钉测引用）。 */
export const INJECTION_TEST_NOTIFY_PREFIX = "[tavern-inject]";

/** 身份行观察通道前缀（identity-consistency.test.ts:195 断言引用）。 */
export const INJECTION_TEST_IDENTITY_NOTIFY_PREFIX = "[tavern-test-injection]";
