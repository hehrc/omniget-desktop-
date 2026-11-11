<script>
  import Icon from "./Icon.svelte";
  import { app, dismissToast } from "../lib/state.svelte.js";

  const ICON = {
    success: "check-circle",
    error: "alert-circle",
    info: "info",
    warning: "alert-triangle",
  };
</script>

<div class="toast-region" role="status" aria-live="polite">
  {#each app.toasts as toast (toast.id)}
    <div class="toast toast-{toast.type}">
      <span class="toast-icon">
        <Icon name={ICON[toast.type] || "info"} size={16} />
      </span>
      <span class="toast-message">{toast.message}</span>
      <button class="toast-close" onclick={() => dismissToast(toast.id)} aria-label="Dismiss">
        <Icon name="x" size={12} />
      </button>
    </div>
  {/each}
</div>

<style>
  .toast-message {
    flex: 1;
    min-width: 0;
    line-height: 1.45;
    word-break: break-word;
  }
  .toast-close {
    color: var(--quaternary);
    padding: 2px;
    border-radius: 4px;
    flex: 0 0 auto;
  }
  .toast-close:hover {
    background: var(--surface-hi);
    color: var(--secondary);
  }
</style>
