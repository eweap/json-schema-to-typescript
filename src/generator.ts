import { whiteBright } from 'cli-color'
import { omit } from 'lodash'
import { DEFAULT_OPTIONS, Options } from './index'
import {
  AST, ASTWithStandaloneName, hasComment, hasStandaloneName, TArray, TEnum, TInterface, TIntersection,
  TNamedInterface, TUnion
} from './types/AST'
import { log, toSafeString } from './utils'

let processedNamedTypes = new Set<AST>()
let processedNamedInterfaces = new Set<AST>()
let processedEnums = new Set<AST>()

export function resetProcessed(): void {
  processedNamedTypes.clear()
  processedNamedInterfaces.clear()
  processedEnums.clear()
}

export function generate(ast: AST, options = DEFAULT_OPTIONS): string {
  const declaredNamedTypes = declareNamedTypes(ast, options, processedNamedTypes)
  processedNamedTypes = declaredNamedTypes.processed
  const declaredNamedInterfaces = declareNamedInterfaces(ast, options, ast.standaloneName!, processedNamedInterfaces)
  processedNamedInterfaces = declaredNamedInterfaces.processed
  const declaredEnums = declareEnums(ast, options, processedEnums)
  processedEnums = declaredEnums.processed

  return [
    options.bannerComment,
    declaredNamedTypes.type,
    declaredNamedInterfaces.type,
    declaredEnums.type
  ]
    .filter(Boolean)
    .join('\n\n')
    + '\n' // trailing newline
}

function declareEnums(
  ast: AST,
  options: Options,
  processed = new Set<AST>()
): { type: string, processed: Set<AST> } {
  // Search for processed enums with the same name
  const processedResults = Array.from(processed.keys()).filter(processedAST => {
    if (processedAST.standaloneName === undefined || ast.standaloneName === undefined) {
      return false
    }

    return processedAST.standaloneName === ast.standaloneName
  }) || []

  if (processed.has(ast) || processedResults.length > 0) {
    return { type: '', processed }
  }

  processed.add(ast)
  let type = ''

  switch (ast.type) {
    case 'ENUM':
      type = generateStandaloneEnum(ast, options) + '\n'
      break
    case 'ARRAY':
      return declareEnums(ast.params, options, processed)
    case 'TUPLE':
      return ast.params.reduce((prev, ast) => prev + declareEnums(ast, options, processed), '') as any
    case 'INTERFACE':
      type = getSuperTypesAndParams(ast).reduce((prev, ast) =>
        prev + declareEnums(ast, options, processed).type,
        '')
      break
    default:
      type = ''
  }

  return { type, processed }
}

function declareNamedInterfaces(
  ast: AST,
  options: Options,
  rootASTName: string,
  processed = new Set<AST>()
): { type: string, processed: Set<AST> } {
  if (processed.has(ast)) {
    return { type: '', processed }
  }

  processed.add(ast)
  let type = ''

  switch (ast.type) {
    case 'ARRAY':
      return declareNamedInterfaces((ast as TArray).params, options, rootASTName, processed)
    case 'INTERFACE':
      type = [
        hasStandaloneName(ast) && (ast.standaloneName === rootASTName || options.declareExternallyReferenced) && generateStandaloneInterface(ast, options),
        getSuperTypesAndParams(ast).map(ast =>
          declareNamedInterfaces(ast, options, rootASTName, processed).type
        ).filter(Boolean).join('\n')
      ].filter(Boolean).join('\n')
      break
    case 'INTERSECTION':
    case 'UNION':
      type = ast.params.map(_ => declareNamedInterfaces(_, options, rootASTName, processed).type).filter(Boolean).join('\n')
      break
    default:
      type = ''
  }

  return { type, processed }
}

function declareNamedTypes(
  ast: AST,
  options: Options,
  processed = new Set<AST>()
): { type: string, processed: Set<AST> } {
  if (processed.has(ast)) {
    return { type: '', processed }
  }

  processed.add(ast)
  let type = ''

  switch (ast.type) {
    case 'ARRAY':
      type = [
        declareNamedTypes(ast.params, options, processed).type,
        hasStandaloneName(ast) ? generateStandaloneType(ast, options) : undefined
      ].filter(Boolean).join('\n')
      break
    case 'ENUM':
      type = ''
      break
    case 'INTERFACE':
      type = getSuperTypesAndParams(ast).map(ast => declareNamedTypes(ast, options, processed).type).filter(Boolean).join('\n')
      break
    case 'INTERSECTION':
    case 'TUPLE':
    case 'UNION':
      type = [
        hasStandaloneName(ast) ? generateStandaloneType(ast, options) : undefined,
        ast.params.map(ast => declareNamedTypes(ast, options, processed).type).filter(Boolean).join('\n')
      ].filter(Boolean).join('\n')
      break
    default:
      if (hasStandaloneName(ast)) {
        type = generateStandaloneType(ast, options)
      }
  }

  return { type, processed }
}

function generateType(ast: AST, options: Options): string {
  log(whiteBright.bgMagenta('generator'), ast)

  if (hasStandaloneName(ast)) {
    return toSafeString(ast.standaloneName)
  }

  switch (ast.type) {
    case 'ANY': return 'any'
    case 'ARRAY': return (() => {
      let type = generateType(ast.params, options)
      return type.endsWith('"') ? '(' + type + ')[]' : type + '[]'
    })()
    case 'BOOLEAN': return 'boolean'
    case 'INTERFACE': return generateInterface(ast, options)
    case 'INTERSECTION': return generateSetOperation(ast, options)
    case 'LITERAL': return JSON.stringify(ast.params)
    case 'NUMBER': return 'number'
    case 'NULL': return 'null'
    case 'OBJECT': return 'object'
    case 'REFERENCE': return ast.params
    case 'STRING': return 'string'
    case 'TUPLE': return '['
      + ast.params.map(_ => generateType(_, options)).join(', ')
      + ']'
    case 'UNION': return generateSetOperation(ast, options)
    case 'CUSTOM_TYPE': return ast.param
  }
}

/**
 * Generate a Union or Intersection
 */
function generateSetOperation(ast: TIntersection | TUnion, options: Options): string {
  const members = (ast as TUnion).params.map(_ => generateType(_, options))
  const separator = ast.type === 'UNION' ? '|' : '&'
  return members.length === 1 ? members[0] : '(' + members.join(' ' + separator + ' ') + ')'
}

function generateInterface(
  ast: TInterface,
  options: Options
): string {
  return `{`
    + '\n'
    + ast.params
      .filter(_ => !_.isPatternProperty && !_.isUnreachableDefinition)
      .map(({ isRequired, keyName, ast }) => [isRequired, keyName, ast, generateType(ast, options)] as [boolean, string, AST, string])
      .map(([isRequired, keyName, ast, type]) =>
        (hasComment(ast) && !ast.standaloneName ? generateComment(ast.comment) + '\n' : '')
        + escapeKeyName(keyName)
        + (isRequired ? '' : '?')
        + ': '
        + (hasStandaloneName(ast) ? toSafeString(type) : type)
      )
      .join('\n')
    + '\n'
    + '}'
}

function generateComment(comment: string): string {
  return [
    '/**',
    ...comment.split('\n').map(_ => ' * ' + _),
    ' */'
  ].join('\n')
}

function generateStandaloneEnum(ast: TEnum, options: Options): string {
  return (hasComment(ast) ? generateComment(ast.comment) + '\n' : '')
    + 'export ' + (options.enableConstEnums ? 'const ' : '') + `enum ${toSafeString(ast.standaloneName)} {`
    + '\n'
    + ast.params.map(({ ast, keyName }) =>
      keyName + ' = ' + generateType(ast, options)
    )
      .join(',\n')
    + '\n'
    + '}'
}

function generateStandaloneInterface(ast: TNamedInterface, options: Options): string {
  return (hasComment(ast) ? generateComment(ast.comment) + '\n' : '')
    + `export interface ${toSafeString(ast.standaloneName)} `
    + (ast.superTypes.length > 0 ? `extends ${ast.superTypes.map(superType => toSafeString(superType.standaloneName)).join(', ')} ` : '')
    + generateInterface(ast, options)
}

function generateStandaloneType(ast: ASTWithStandaloneName, options: Options): string {
  return (hasComment(ast) ? generateComment(ast.comment) + '\n' : '')
    + `export type ${toSafeString(ast.standaloneName)} = ${generateType(omit<AST>(ast, 'standaloneName') as AST /* TODO */, options)}`
}

function escapeKeyName(keyName: string): string {
  if (
    keyName.length
    && /[A-Za-z_$]/.test(keyName.charAt(0))
    && /^[\w$]+$/.test(keyName)
  ) {
    return keyName
  }
  if (keyName === '[k: string]') {
    return keyName
  }
  return JSON.stringify(keyName)
}

function getSuperTypesAndParams(ast: TInterface): AST[] {
  return ast.params
    .map(param => param.ast)
    .concat(ast.superTypes)
}
