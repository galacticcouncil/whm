const ART = String.raw`
 ██╗███╗   ██╗████████╗███████╗███╗   ██╗████████╗
 ██║████╗  ██║╚══██╔══╝██╔════╝████╗  ██║╚══██╔══╝
 ██║██╔██╗ ██║   ██║   █████╗  ██╔██╗ ██║   ██║
 ██║██║╚██╗██║   ██║   ██╔══╝  ██║╚██╗██║   ██║
 ██║██║ ╚████║   ██║   ███████╗██║ ╚████║   ██║
 ╚═╝╚═╝  ╚═══╝   ╚═╝   ╚══════╝╚═╝  ╚═══╝   ╚═╝`;

/**
 * Print the banner with the running app's name. One image, several entry points, so the name is the
 * only thing telling two containers apart in a log.
 *
 * @param name App name.
 */
export function banner(name: string): void {
  console.log(`${ART}\n        ${name}\n`);
}
