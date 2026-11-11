<script>
  import Icon from "./Icon.svelte";
  import Mascot from "./Mascot.svelte";
  import { app } from "../lib/state.svelte.js";

  let {
    icon = "sparkles",
    title = "Nothing here yet",
    message = "",
    actionLabel = "",
    onAction = () => {},
    secondaryLabel = "",
    onSecondary = () => {},
    mascot = true,
    compact = false,
  } = $props();
</script>

<div class="empty" class:compact>
  {#if mascot}
    <Mascot size={compact ? 72 : 96} mood="thinking" />
  {:else}
    <span class="empty-art" style="width: {compact ? 44 : 64}px; height: {compact ? 44 : 64}px">
      <Icon name={icon} size={compact ? 20 : 26} />
    </span>
  {/if}
  <div class="stack stack-1" style="max-width: 380px">
    <p class="empty-title">{title}</p>
    {#if message}<p class="empty-message">{message}</p>{/if}
  </div>
  {#if actionLabel || secondaryLabel}
    <div class="row row-2" style="margin-top: 4px">
      {#if actionLabel}
        <button class="btn btn-primary btn-sm" onclick={onAction}>
          <Icon name="plus" size={12} />
          {actionLabel}
        </button>
      {/if}
      {#if secondaryLabel}
        <button class="btn btn-secondary btn-sm" onclick={onSecondary}>{secondaryLabel}</button>
      {/if}
    </div>
  {/if}
</div>

<style>
  .empty.compact {
    padding: var(--space-5) var(--space-3);
  }
  .empty-title {
    font-family: var(--font-display);
    font-size: var(--text-md);
    font-weight: 600;
    color: var(--secondary);
    letter-spacing: -0.01em;
    line-height: 1.35;
  }
  .empty-message {
    font-size: var(--text-sm);
    line-height: 1.5;
    color: var(--tertiary);
  }
</style>
