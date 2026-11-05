/** Combined source entry. Release builds select modules from this same source. */
import { createToolboxPlugin } from './runtime.ts';
import * as context from './modules/context/index.ts';
import * as retry from './modules/retry/index.ts';
import * as chime from './modules/chime/index.ts';
import * as goalWait from './modules/goal-wait/index.ts';
const plugin = createToolboxPlugin({name: 'dsh-toolbox', moduleIds: ['context', 'retry', 'chime', 'goalWait'], modulePlugins: {context, retry, chime, goalWait}});
export const name = plugin.name;
export const inject = plugin.inject;
export const Config = plugin.Config;
export const apply = plugin.apply;
