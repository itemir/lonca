import { useCallback, useRef, useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import { defaultProfile, profileShortName, profilesOf } from '../../../shared/profiles.ts';
import type { AgentId, Catalog } from '../../../shared/types.ts';
import { effortLabel } from '../format.ts';
import { useOutsideClick } from '../hooks.ts';
import { signInCondition } from '../signins.ts';
import { useStore } from '../store.ts';

export interface ModelChoice {
  agent: AgentId;
  model: string;
  effort: string;
  /** One of `agent`'s sign-ins. Missing means its default. */
  profileId?: string;
}

export function modelLabel(catalog: Catalog, agent: AgentId, model: string): string {
  return catalog[agent].models.find((entry) => entry.id === model)?.label ?? model;
}

/**
 * Chooses an agent, model and effort, and the sign-in when the agent has more than one. A started
 * conversation stays with its agent.
 */
export function ModelPicker({ catalog, value, lockAgent, onChange, up = true, right = false }: {
  catalog: Catalog;
  value: ModelChoice;
  lockAgent?: boolean;
  onChange: (choice: ModelChoice) => void;
  up?: boolean;
  right?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useOutsideClick(ref, close, open);
  const profiles = useStore((store) => store.profiles);
  const system = useStore((store) => store.system);
  const current = catalog[value.agent].models.find((entry) => entry.id === value.model);
  const efforts = current?.efforts ?? [];
  const signIns = profilesOf(profiles, value.agent);
  const signIn = signIns.find((profile) => profile.id === value.profileId) ?? defaultProfile(profiles, value.agent);
  const several = signIns.length > 1;

  const pickModel = (agent: AgentId, modelId: string) => {
    const model = catalog[agent].models.find((entry) => entry.id === modelId);
    const effort = model?.efforts.includes(value.effort) ? value.effort : model?.defaultEffort ?? value.effort;
    // A sign-in is one provider's, so another provider's model goes with that one's default.
    onChange({ agent, model: modelId, effort, profileId: agent === value.agent ? value.profileId : defaultProfile(profiles, agent)?.id });
  };

  return (
    <div className="model-picker" ref={ref}>
      <button type="button" className="model-button" aria-expanded={open} onClick={() => setOpen((state) => !state)}>
        <span>{modelLabel(catalog, value.agent, value.model)}</span>
        <span className="model-effort">{effortLabel(value.effort)}</span>
        {several && <span className="model-sign-in">{profileShortName(signIn, catalog)}</span>}
        <ChevronDown size={14} />
      </button>
      {open && (
        <div className={`popover model-popover ${up ? 'popover-up' : 'popover-down'} ${right ? 'popover-right' : ''}`}>
          <div className="model-columns">
            <div className="model-column">
              {(Object.keys(catalog) as AgentId[]).map((agent) => {
                const disabled = lockAgent && agent !== value.agent;
                return (
                  <div key={agent} className="model-group">
                    <div className="popover-heading">{catalog[agent].label}</div>
                    {catalog[agent].models.map((model) => (
                      <button
                        key={model.id}
                        type="button"
                        className="menu-item"
                        disabled={disabled}
                        title={disabled ? 'Open a new tab to use a different agent' : undefined}
                        onClick={() => pickModel(agent, model.id)}
                      >
                        <span className="menu-check">{model.id === value.model && agent === value.agent && <Check size={14} />}</span>
                        {model.label}
                      </button>
                    ))}
                  </div>
                );
              })}
            </div>
            <div className="model-column model-efforts">
              <div className="popover-heading">Effort</div>
              {efforts.map((effort) => (
                <button
                  key={effort}
                  type="button"
                  className="menu-item"
                  onClick={() => {
                    onChange({ ...value, effort });
                    setOpen(false);
                  }}
                >
                  <span className="menu-check">{effort === value.effort && <Check size={14} />}</span>
                  {effortLabel(effort)}
                </button>
              ))}
            </div>
          </div>
          {several && (
            <div className="model-sign-ins" role="group" aria-label="Sign-in">
              <div className="popover-heading">Sign-in</div>
              {signIns.map((profile) => {
                const condition = signInCondition(system, profile.id);
                return (
                  <button
                    key={profile.id}
                    type="button"
                    className="menu-item"
                    aria-pressed={profile.id === signIn?.id}
                    onClick={() => {
                      onChange({ ...value, profileId: profile.id });
                      setOpen(false);
                    }}
                  >
                    <span className="menu-check">{profile.id === signIn?.id && <Check size={14} />}</span>
                    <span className="menu-label">{profileShortName(profile, catalog)}</span>
                    {condition && <span className="menu-note">{condition}</span>}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
