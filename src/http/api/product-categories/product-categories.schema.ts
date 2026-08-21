import { z } from "zod";

export const CategoryNameField = z.string().trim().min(2).max(60);

export const CreateCategoryBody = z.object({ name: CategoryNameField });
export type CreateCategoryBody = z.infer<typeof CreateCategoryBody>;

export const UpdateCategoryBody = z.object({ name: CategoryNameField });
export type UpdateCategoryBody = z.infer<typeof UpdateCategoryBody>;

/**
 * Reordenar é uma chamada só com a ordem inteira: subir uma categoria três vezes não
 * pode virar três requests que se atropelam e deixam a lista com posições repetidas.
 */
export const ReorderCategoriesBody = z.object({
  ids: z.array(z.string().uuid()).min(1).max(200),
});
export type ReorderCategoriesBody = z.infer<typeof ReorderCategoriesBody>;

export const CategoryResponse = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  position: z.number().int(),
  /** Só produtos ativos: a vitrine não pode prometer 12 e entregar 3. */
  productCount: z.number().int(),
});

export const CategoriesResponse = z.object({
  items: z.array(CategoryResponse),
  /**
   * Produtos ativos da loja inteira, inclusive os sem categoria. A vitrine precisa do
   * número exato para o "Tudo" e para o topo da página; somar as gavetas daria menos.
   */
  total: z.number().int(),
});

export const CategoryIdParams = z.object({ slug: z.string(), id: z.string().uuid() });
