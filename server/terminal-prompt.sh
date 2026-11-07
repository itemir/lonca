# Lonca's terminals go by lonca@<project>-<branch> rather than the VM's user and host. Each boot
# writes this where the end of ~/.bashrc sources it, after the prompt that sets.
if [ -n "${LONCA_PROJECT_SLUG-}" ]; then
  # Read at every prompt, so switching branches shows. With none checked out, as in the middle of
  # a rebase, it's the workspace's own, which ends in its name.
  __lonca_branch() {
    local branch
    branch=$(git -C "${LONCA_WORKSPACE_PATH-.}" branch --show-current 2>/dev/null)
    branch=${branch:-${LONCA_WORKSPACE_NAME-}}
    printf '%s' "${branch##*/}"
  }
  PS1='lonca@${LONCA_PROJECT_SLUG}-$(__lonca_branch):\W\$ '
fi
