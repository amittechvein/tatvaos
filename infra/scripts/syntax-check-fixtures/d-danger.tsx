export function Styles({ css }: { css: string }) {
  return <style dangerouslySetInnerHTML={{ __html: css }} />;
}
