export const NAVIGATION_INTENT = 'rete-navigation-intent';
export function requestNavigation(proceed: () => void) {
  const event = new CustomEvent(NAVIGATION_INTENT, { cancelable: true, detail: { proceed } });
  if (window.dispatchEvent(event)) proceed();
}
