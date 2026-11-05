/** Distribution selection is the sole packaging source of truth. */
export const distributions = [
  { name: 'dsh-toolbox', modules: ['context', 'retry', 'chime', 'goalWait'] },
  { name: 'dsh-toolbox-context', modules: ['context'] },
  { name: 'dsh-toolbox-retry', modules: ['retry'] },
  { name: 'dsh-toolbox-chime', modules: ['chime'] },
  { name: 'dsh-toolbox-goal-wait', modules: ['goalWait'] },
];
export const sourceDirectories = { context: 'context', retry: 'retry', chime: 'chime', goalWait: 'goal-wait' };
export const clientDependencies = {
  context: ['@deepseek-ai/dsh-client-ui-settings', '@deepseek-ai/dsh-client-ui-plugin-manager'],
  retry: ['@deepseek-ai/dsh-client-ui-settings', '@deepseek-ai/dsh-client-ui-plugin-manager'],
  chime: ['@deepseek-ai/dsh-api-session-controller', '@deepseek-ai/dsh-api-job-controller', '@deepseek-ai/dsh-api-remotes', '@deepseek-ai/dsh-client-locale', '@deepseek-ai/dsh-client-ui-session', '@deepseek-ai/dsh-client-ui-settings', '@deepseek-ai/dsh-client-ui-plugin-manager'],
  goalWait: ['@deepseek-ai/dsh-client-ui-settings', '@deepseek-ai/dsh-client-ui-plugin-manager'],
};
