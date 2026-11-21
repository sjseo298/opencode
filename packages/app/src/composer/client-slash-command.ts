type ClientSlashCommand = {
  id: string
  trigger: string
  arguments?: boolean
  type: "builtin" | "custom"
}

export type SlashCommandEntry = ClientSlashCommand & {
  suggestionId: string
  title: string
  description?: string
}

export function buildSlashCommandEntries(
  custom: readonly { name: string; description?: string }[],
  builtins: readonly {
    id: string
    slash?: string
    slashAliases?: readonly string[]
    slashArguments?: boolean
    title: string
    description?: string
    disabled?: boolean
  }[],
): SlashCommandEntry[] {
  const seen = new Set<string>()

  const uniqueId = (base: string, trigger: string) => {
    const candidate = seen.has(base) ? `${base}:${trigger}` : base
    const resolved = seen.has(candidate) ? `${candidate}:${seen.size}` : candidate

    seen.add(resolved)

    return resolved
  }

  return [
    ...custom.map((item) => ({
      id: `custom.${item.name}`,
      suggestionId: uniqueId(`custom.${item.name}`, item.name),
      trigger: item.name,
      title: item.name,
      description: item.description,
      type: "custom" as const,
    })),
    ...builtins
      .filter((item) => !item.disabled && !item.id.startsWith("suggested.") && item.slash)
      .flatMap((item) => {
        const triggers = [item.slash!, ...(item.slashAliases ?? [])]

        return triggers.map((trigger, index) => ({
          id: item.id,
          suggestionId: uniqueId(index === 0 ? item.id : `${item.id}:${trigger}`, trigger),
          trigger,
          title: item.title,
          description: item.description,
          arguments: item.slashArguments,
          type: "builtin" as const,
        }))
      }),
  ]
}

export function parseSlashCommand(text: string) {
  if (!text.startsWith("/")) return
  const separator = text.search(/\s/)
  const name = text.slice(1, separator === -1 ? undefined : separator)

  return { name, input: separator === -1 ? "" : text.slice(separator).trim() }
}

export function parseClientSlashCommand(options: readonly ClientSlashCommand[], text: string) {
  const command = parseSlashCommand(text)

  if (!command) return
  const option = options.find((item) => item.type === "builtin" && item.arguments && item.trigger === command.name)

  if (!option) return

  return {
    id: option.id,
    input: command.input,
  }
}
